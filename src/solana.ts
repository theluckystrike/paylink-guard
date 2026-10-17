import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "./spl.js";
import {
  PayLinkError,
  type Check,
  type PaymentRequest,
  SOLANA_USDC_MINT,
  HOSTS,
  FETCH_TIMEOUT_MS,
} from "./types.js";
import { rpcPost } from "./net.js";
import { proposeSolana } from "./paybox.js";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const ZERO_BLOCKHASH = "11111111111111111111111111111111";
const U64_MAX = 2n ** 64n;

function toPublicKey(value: string, code: string, message: string): PublicKey {
  if (typeof value !== "string") {
    throw new PayLinkError(code, message);
  }
  try {
    return new PublicKey(value);
  } catch {
    throw new PayLinkError(code, message);
  }
}

function parseAtomic(atomic: string): bigint {
  if (typeof atomic !== "string" || !/^(0|[1-9][0-9]*)$/.test(atomic)) {
    throw new PayLinkError("invalid_amount", "Amount must be a non-negative integer in atomic units.");
  }
  const value = BigInt(atomic);
  if (value >= U64_MAX) {
    throw new PayLinkError("invalid_amount", "Amount exceeds the 64-bit Solana limit.");
  }
  return value;
}

/** Solana Pay: each reference key is appended to the transfer instruction as a read-only, non-signer key. */
function withReferences(ix: TransactionInstruction, references: readonly string[]): TransactionInstruction {
  for (const reference of references) {
    ix.keys.push({
      pubkey: toPublicKey(reference, "invalid_reference", "Reference must be a valid base58 Solana public key."),
      isSigner: false,
      isWritable: false,
    });
  }
  return ix;
}

/** Idempotent recipient ATA creation plus a transferChecked of USDC (6 decimals). */
function usdcInstructions(senderKey: PublicKey, recipientKey: PublicKey, amount: bigint) {
  const mint = new PublicKey(SOLANA_USDC_MINT);
  // allowOwnerOffCurve: a program-derived recipient (for example a multisig vault) can own a token account.
  const recipientAta = getAssociatedTokenAddressSync(mint, recipientKey, true);
  let senderAta: PublicKey;
  try {
    senderAta = getAssociatedTokenAddressSync(mint, senderKey);
  } catch {
    throw new PayLinkError("invalid_sender", "Sender must be a regular wallet address, not a program-derived address.");
  }
  return {
    createAta: createAssociatedTokenAccountIdempotentInstruction(senderKey, recipientAta, recipientKey, mint),
    transfer: createTransferCheckedInstruction(senderAta, mint, recipientAta, senderKey, amount, 6),
  };
}

/** Build an unsigned Solana transaction proposal. sender must be the payer's base58 public key. */
export function buildSolanaProposal(req: PaymentRequest, atomic: string, sender: string) {
  const senderKey = toPublicKey(sender, "invalid_sender", "Sender must be a valid base58 Solana public key.");
  const recipientKey = toPublicKey(req.recipient, "invalid_recipient", "Recipient must be a valid base58 Solana public key.");
  if (senderKey.equals(recipientKey)) {
    throw new PayLinkError("self_payment", "Sender and recipient must be different accounts.");
  }
  if (req.chain !== "solana" || req.standard !== "solana-pay" || req.caip2 !== "solana:mainnet") {
    throw new PayLinkError("unsupported_chain", "This builder only handles Solana Pay links on Solana mainnet.");
  }

  const amount = parseAtomic(atomic);

  const tx = new Transaction();
  tx.feePayer = senderKey;
  tx.recentBlockhash = ZERO_BLOCKHASH;

  // Solana Pay spec: the memo instruction goes immediately before the transfer instruction.
  const memo = req.memo === undefined ? null : new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(req.memo, "utf8"),
  });

  if (req.asset.symbol === "SOL") {
    if (memo) tx.add(memo);
    tx.add(withReferences(SystemProgram.transfer({ fromPubkey: senderKey, toPubkey: recipientKey, lamports: amount }), req.references));
  } else if (req.asset.symbol === "USDC") {
    const { createAta, transfer } = usdcInstructions(senderKey, recipientKey, amount);
    tx.add(createAta);
    if (memo) tx.add(memo);
    tx.add(withReferences(transfer, req.references));
  } else {
    throw new PayLinkError("unsupported_token", `Asset ${req.asset.symbol} is not supported on Solana.`);
  }

  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return proposeSolana({ transactionBase64: serialized.toString("base64") });
}

const SYSTEM_PROGRAM = SystemProgram.programId.toBase58();
/** Rent-exempt minimum for a 0-byte system account. A smaller SOL transfer to a new account fails on chain. */
export const RENT_EXEMPT_MIN_LAMPORTS = 890_880n;
/** Rent for a new token account, paid by the sender when the recipient has no USDC account yet. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;
/** Base fee for one signature plus a margin for priority fees. */
export const FEE_MARGIN_LAMPORTS = 100_000n;

type Account = {
  owner?: string;
  executable?: boolean;
  lamports?: number;
  data?: { parsed?: { info?: { state?: string; tokenAmount?: { amount?: string } } } } | unknown;
} | null;

/** One getMultipleAccounts call for all keys: fewer requests under public RPC rate limits. */
async function getAccounts(fetchFn: typeof fetch, keys: string[]): Promise<Account[]> {
  const result = (await rpcPost(fetchFn, [HOSTS.solanaRpc, HOSTS.solanaRpcFallback], "getMultipleAccounts", [keys, { encoding: "jsonParsed", commitment: "confirmed" }])) as { value?: unknown } | null;
  if (!Array.isArray(result?.value) || result.value.length !== keys.length) throw new Error("bad RPC response");
  return result.value as Account[];
}

function tokenInfo(account: Account): { state?: string; amount?: bigint } {
  const info = (account?.data as { parsed?: { info?: { state?: string; tokenAmount?: { amount?: string } } } } | undefined)?.parsed?.info;
  const raw = info?.tokenAmount?.amount;
  return { state: info?.state, amount: typeof raw === "string" && /^\d+$/.test(raw) ? BigInt(raw) : undefined };
}

function lamportsOf(account: Account): bigint {
  return account && typeof account.lamports === "number" && Number.isSafeInteger(account.lamports) ? BigInt(account.lamports) : 0n;
}

function sol(lamports: bigint): string {
  const s = lamports.toString().padStart(10, "0");
  return `${s.slice(0, -9)}.${s.slice(-9)}`.replace(/\.?0+$/, "");
}

function usdc(atomic: bigint): string {
  const s = atomic.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/\.?0+$/, "");
}

function recipientTypeCheck(req: PaymentRequest, account: Account, usdcAccount?: Account): Check {
  const id = "solana_recipient_type";
  // A wallet that only ever received USDC (for example from an exchange) has no SOL account but a live USDC account.
  if (account == null && usdcAccount?.owner === TOKEN_PROGRAM_ID.toBase58()) {
    return { id, status: "pass", detail: "Recipient wallet holds no SOL but already has a USDC account." };
  }
  if (account == null) {
    const amount = req.atomicAmount === null ? null : BigInt(req.atomicAmount);
    if (req.asset.symbol === "SOL" && amount !== null && amount < RENT_EXEMPT_MIN_LAMPORTS) {
      return { id, status: "fail", detail: `Recipient account does not exist, and ${sol(amount)} SOL is below the ${sol(RENT_EXEMPT_MIN_LAMPORTS)} SOL minimum for a new account. The transfer would fail.` };
    }
    return { id, status: "warn", detail: "Recipient account does not exist yet (no SOL, no history). Check the address." };
  }
  if (account.owner === TOKEN_PROGRAM_ID.toBase58() || account.owner === TOKEN_2022_PROGRAM_ID.toBase58()) {
    return { id, status: "fail", detail: "Recipient is a token account, not a wallet. Funds sent to it this way can be lost. Ask for the wallet address." };
  }
  if (account.executable) {
    return { id, status: "fail", detail: "Recipient is a program, not a wallet. Ask for the wallet address." };
  }
  if (account.owner !== SYSTEM_PROGRAM) {
    return { id, status: "warn", detail: `Recipient is a data account owned by program ${account.owner ?? "unknown"}, not a regular wallet. Confirm with the merchant.` };
  }
  if (!PublicKey.isOnCurve(new PublicKey(req.recipient).toBytes())) {
    return { id, status: "warn", detail: "Recipient is a program-controlled address (for example a multisig vault). Confirm the merchant uses one." };
  }
  return { id, status: "pass", detail: "Recipient is a regular wallet." };
}

function usdcAccountCheck(account: Account): Check {
  const id = "solana_recipient_usdc_account";
  if (account == null) return { id, status: "pass", detail: "Recipient has no USDC account yet. The proposal creates it (about 0.002 SOL rent, paid by you)." };
  if (account.owner !== TOKEN_PROGRAM_ID.toBase58()) return { id, status: "fail", detail: "The recipient's USDC account address holds an unexpected account. Do not pay." };
  if (tokenInfo(account).state === "frozen") return { id, status: "fail", detail: "The recipient's USDC account is frozen. The transfer would fail." };
  return { id, status: "pass", detail: "Recipient already has a USDC account." };
}

function senderCheck(req: PaymentRequest, wallet: Account, senderAta: Account | undefined, recipientAta: Account | undefined, recipient: Account): Check {
  const id = "solana_sender_balance";
  const amount = BigInt(req.atomicAmount ?? "0");
  const lamports = lamportsOf(wallet);
  if (req.asset.symbol === "SOL") {
    const need = amount + FEE_MARGIN_LAMPORTS + RENT_EXEMPT_MIN_LAMPORTS;
    if (lamports < need) return { id, status: "fail", detail: `Your wallet has ${sol(lamports)} SOL. This payment needs about ${sol(need)} SOL: the amount, fees, and the ${sol(RENT_EXEMPT_MIN_LAMPORTS)} SOL a wallet must keep.` };
    return { id, status: "pass", detail: `Your wallet has ${sol(lamports)} SOL, enough for this payment and fees.` };
  }
  const have = senderAta == null ? 0n : tokenInfo(senderAta).amount ?? 0n;
  if (have < amount) return { id, status: "fail", detail: `Your wallet has ${usdc(have)} USDC. The link asks for ${usdc(amount)} USDC.` };
  const needSol = FEE_MARGIN_LAMPORTS + RENT_EXEMPT_MIN_LAMPORTS + (recipientAta == null ? TOKEN_ACCOUNT_RENT_LAMPORTS : 0n);
  if (lamports < needSol) return { id, status: "fail", detail: `Your wallet has ${sol(lamports)} SOL. It needs about ${sol(needSol)} SOL for fees${recipientAta == null ? " and the recipient's new USDC account" : ""}.` };
  void recipient;
  return { id, status: "pass", detail: `Your wallet has ${usdc(have)} USDC and enough SOL for fees.` };
}

/** Turn the fetched accounts into checks, in the same order as accountKeys. */
function assembleChecks(req: PaymentRequest, isUsdc: boolean, accounts: Account[], hasSender: boolean): Check[] {
  const recipient = accounts[0] ?? null;
  const recipientAta = isUsdc ? accounts[1] ?? null : undefined;
  const checks: Check[] = [recipientTypeCheck(req, recipient, recipientAta)];
  // When the recipient itself is blocked, a USDC account line would only confuse the reader.
  if (isUsdc && checks[0]!.status !== "fail") checks.push(usdcAccountCheck(recipientAta ?? null));
  if (hasSender) {
    const base = isUsdc ? 2 : 1;
    checks.push(senderCheck(req, accounts[base] ?? null, isUsdc ? accounts[base + 1] ?? null : undefined, recipientAta, recipient));
  }
  return checks;
}

/** Accounts to read, in order: recipient, [recipient USDC ATA], [sender, [sender USDC ATA]]. */
function accountKeys(req: PaymentRequest, isUsdc: boolean, sender?: string): { keys: string[]; senderKey: PublicKey | null } {
  const mint = new PublicKey(SOLANA_USDC_MINT);
  const keys = [req.recipient];
  if (isUsdc) keys.push(getAssociatedTokenAddressSync(mint, new PublicKey(req.recipient), true).toBase58());
  if (sender === undefined) return { keys, senderKey: null };
  try {
    const senderKey = new PublicKey(sender);
    const senderKeys = [senderKey.toBase58()];
    if (isUsdc) senderKeys.push(getAssociatedTokenAddressSync(mint, senderKey).toBase58());
    return { keys: [...keys, ...senderKeys], senderKey };
  } catch {
    // An invalid or off-curve sender is rejected later by buildSolanaProposal with a clear error.
    return { keys, senderKey: null };
  }
}

/**
 * Check a Solana Pay recipient (and the payer's balance when sender is given) with one RPC call.
 * Network failures or timeouts yield "unknown", never a throw.
 */
export async function checkSolanaRecipient(req: PaymentRequest, fetchFn: typeof fetch = fetch, sender?: string): Promise<Check[]> {
  const isUsdc = req.asset.symbol === "USDC";
  const { keys, senderKey } = accountKeys(req, isUsdc, sender);

  let accounts: Account[];
  try {
    accounts = await getAccounts(fetchFn, keys);
  } catch {
    const out: Check[] = [{ id: "solana_recipient_type", status: "unknown", detail: "Could not check the recipient account (Solana RPC unavailable)." }];
    if (isUsdc) out.push({ id: "solana_recipient_usdc_account", status: "unknown", detail: "Could not check the recipient's USDC account." });
    if (senderKey) out.push({ id: "solana_sender_balance", status: "unknown", detail: "Could not check your wallet balance." });
    return out;
  }

  return assembleChecks(req, isUsdc, accounts, senderKey !== null);
}
