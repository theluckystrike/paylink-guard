import { createHmac } from "node:crypto";

import { checkBaseRecipient, checkBaseSender } from "./evm.js";
import { fromAtomic, parsePaymentLink, resolveAmount, toAtomic } from "./links.js";
import { checkGoPlus, verdict } from "./risk.js";
import { checkSolanaRecipient } from "./solana.js";
import { PayLinkError, type Check, type PaymentRequest } from "./types.js";

export async function runChecks(req: PaymentRequest, sender?: string): Promise<Check[]> {
  if (req.chain === "base") {
    const [onchain, goplus, payer] = await Promise.all([
      checkBaseRecipient(req.recipient),
      checkGoPlus(req.recipient),
      sender === undefined || req.atomicAmount === null ? Promise.resolve(null) : checkBaseSender(req, req.atomicAmount, sender),
    ]);
    return payer === null ? [...onchain, goplus] : [...onchain, goplus, payer];
  }
  return checkSolanaRecipient(req, fetch, sender);
}

/** Link text is untrusted: strip control characters and newlines so a label cannot forge check lines. */
function untrusted(text: string): string {
  return JSON.stringify(text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60));
}

export function summary(req: PaymentRequest, amount: string, checks: Check[]) {
  const lines = checks.map((c) => `- ${c.status.toUpperCase()} ${c.id}: ${c.detail}`);
  const who = req.label ? ` (merchant label, not verified: ${untrusted(req.label)})` : "";
  return [
    `Unsigned proposal: pay ${amount} ${req.asset.symbol} on ${req.chain === "base" ? "Base" : "Solana"} to ${req.recipient}${who}.`,
    "Checks:",
    ...lines,
    "PayBox will simulate it and ask the user to approve. Nothing is signed or sent yet.",
  ].join("\n");
}

/** Confirmation codes expire with a 5-minute window; the current and the previous window are accepted. */
const CONFIRM_WINDOW_MS = 300_000;

/**
 * Stateless confirmation: binds a caution override to this link, amount and set of reasons, and to a time window.
 * Keyed with PAYLINK_CONFIRM_KEY (a portal variable), so a merchant cannot compute a valid code in advance.
 */
export function confirmCode(req: PaymentRequest, atomic: string, checks: Check[], window = Math.floor(Date.now() / CONFIRM_WINDOW_MS)): string {
  const open = checks.filter((c) => c.status !== "pass").map((c) => `${c.id}:${c.status}`);
  const key = process.env.PAYLINK_CONFIRM_KEY ?? "paylink-guard-unkeyed";
  return createHmac("sha256", key).update([window, req.raw, atomic, ...open].join("|")).digest("hex").slice(0, 8);
}

function codeMatches(given: string | undefined, req: PaymentRequest, atomic: string, checks: Check[]): boolean {
  if (given === undefined) return false;
  const now = Math.floor(Date.now() / CONFIRM_WINDOW_MS);
  return [now, now - 1].some((w) => confirmCode(req, atomic, checks, w) === given);
}

export type PayArgs = { link: string; asset: "USDC" | "ETH" | "SOL"; max_amount: string; amount?: string; expected_recipient?: string; confirm_code?: string };

/** Intent checks that need no network: chain, asset, recipient, amount and the spending cap. */
export function checkIntent(args: PayArgs, chain: "base" | "solana") {
  const req = parsePaymentLink(args.link);
  if (req.chain !== chain) {
    const other = req.chain === "base" ? "pay_base_link" : "pay_solana_link";
    throw new PayLinkError("wrong_tool", `The link is a ${req.chain === "base" ? "Base" : "Solana"} payment link. Use ${other}.`);
  }
  if (req.asset.symbol !== args.asset) {
    throw new PayLinkError("asset_mismatch", `This link asks for ${req.asset.symbol}, not ${args.asset}. No proposal was made. Confirm the asset with the user.`);
  }
  // Base addresses are case-insensitive hex; Solana base58 is case-sensitive.
  const want = args.expected_recipient?.trim();
  const same = want === undefined || (req.chain === "base" ? want.toLowerCase() === req.recipient.toLowerCase() : want === req.recipient);
  if (!same) {
    throw new PayLinkError("recipient_mismatch", `This link pays ${req.recipient}, not the expected ${want}. No proposal was made.`);
  }
  const { amount, atomic } = resolveAmount(req, args.amount);
  if (BigInt(atomic) === 0n) throw new PayLinkError("invalid_amount", "The amount is zero. Ask the merchant for a link with an amount.");
  let cap: bigint;
  try {
    cap = BigInt(toAtomic(args.max_amount, req.asset.decimals));
  } catch {
    throw new PayLinkError("invalid_max_amount", `max_amount has more decimal places than ${req.asset.symbol} supports (${req.asset.decimals}).`);
  }
  if (BigInt(atomic) > cap) {
    const who = req.amount === null ? "You asked to pay" : "The link asks for";
    throw new PayLinkError("over_max", `${who} ${amount} ${req.asset.symbol}, more than the user's maximum of ${fromAtomic(cap.toString(), req.asset.decimals)} ${req.asset.symbol}. No proposal was made.`);
  }
  return { req, amount, atomic };
}

/** Shared gate for both pay tools: intent, then live checks, then the verdict. */
export async function gate(args: PayArgs, chain: "base" | "solana", sender?: string) {
  const { req, amount, atomic } = checkIntent(args, chain);
  if (chain === "solana" && sender === undefined) {
    throw new PayLinkError("missing_sender", "Pass sender: the public address of the user's Solana wallet in PayBox.");
  }
  // Checks use the resolved amount, so rent and balance checks also work for links without an amount.
  const checks = await runChecks({ ...req, amount, atomicAmount: atomic }, sender);
  const recipientChecks = checks.filter((c) => !c.id.endsWith("sender_balance"));
  if (recipientChecks.every((c) => c.status === "unknown")) {
    throw new PayLinkError("unverified", "No recipient check could run (network unavailable). No proposal was made. Try again in a minute.");
  }
  const v = verdict(checks);
  const what = `${amount} ${req.asset.symbol} to ${req.recipient}`;
  if (v.verdict === "block") throw new PayLinkError("blocked", `Payment of ${what} blocked. ${v.reasons.join(" ")} No proposal was made.`);
  if (v.verdict === "caution") {
    if (!codeMatches(args.confirm_code, req, atomic, checks)) {
      const code = confirmCode(req, atomic, checks);
      throw new PayLinkError("needs_confirmation", `Check before paying ${what}: ${v.reasons.join(" ")} Show these reasons to the user. If the user confirms, call again with confirm_code: "${code}".`);
    }
  }
  return { req, amount, atomic, checks };
}

