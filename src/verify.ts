import { rpcPost } from "./net.js";
import { BASE_USDC, HOSTS, PayLinkError, SOLANA_USDC_MINT } from "./types.js";
import type { PaymentRequest } from "./types.js";

export interface VerifyResult {
  status: "paid" | "not_found" | "mismatch" | "failed" | "pending";
  verified: boolean;
  transaction: string | null;
  detail: string;
}

const SOL_RPC: readonly string[] = [HOSTS.solanaRpc, HOSTS.solanaRpcFallback];
const BASE_RPC: readonly string[] = [HOSTS.baseRpc, HOSTS.baseRpcFallback];
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function units(atomic: bigint, decimals: number): string {
  const s = atomic.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, "");
}

function result(status: VerifyResult["status"], transaction: string | null, detail: string): VerifyResult {
  return { status, verified: status === "paid", transaction, detail };
}

function rpcDown(chain: "base" | "solana"): VerifyResult {
  const name = chain === "solana" ? "Solana" : "Base";
  return result("pending", null, `Could not reach the ${name} RPC. Try again.`);
}

/** Stop starting new RPC attempts after 8 s, so the tool answers inside the 10 s hosted budget. */
const BUDGET_MS = 8000;
/** How many recent reference signatures to examine (spam on a public reference can push a payment down). */
const MAX_CANDIDATES = 8;

export async function verifyPayment(
  req: PaymentRequest,
  opts: { signature?: string; txHash?: string; minBlock?: number },
  fetchFn: typeof fetch = fetch,
): Promise<VerifyResult> {
  const deadline = Date.now() + BUDGET_MS;
  if (req.atomicAmount === null) {
    throw new PayLinkError("missing_amount", "This link has no amount. Provide an amount to pay.");
  }
  const amount = BigInt(req.atomicAmount);
  try {
    if (req.chain === "solana") return await verifySolana(req, opts, amount, fetchFn, deadline);
    return await verifyBase(req, opts, amount, fetchFn, deadline);
  } catch (err) {
    if (err instanceof PayLinkError) throw err;
    return rpcDown(req.chain);
  }
}

// ---------------------------------------------------------------------------
// Solana
// ---------------------------------------------------------------------------

type TokenBalance = { mint?: string; owner?: string; uiTokenAmount?: { amount?: string } };
type SolanaTx = {
  meta?: {
    err?: unknown;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction?: { message?: { accountKeys?: Array<{ pubkey?: string } | string> } };
};

async function verifySolana(req: PaymentRequest, opts: { signature?: string }, amount: bigint, fetchFn: typeof fetch, deadline: number): Promise<VerifyResult> {
  if (!opts.signature && req.references.length === 0) {
    throw new PayLinkError("needs_reference", "This link has no reference key. Pass the transaction signature.");
  }
  const candidates = opts.signature ? [opts.signature] : await getSignatures(fetchFn, req.references[0]!, deadline);
  if (candidates.length === 0) return result("not_found", null, "No successful transaction with this reference yet.");
  const best = await evaluateSolana(req, amount, candidates.slice(0, MAX_CANDIDATES), fetchFn, deadline);
  if (best.status === "mismatch" && best.transaction === null && !opts.signature) {
    return { ...best, detail: `Checked the latest ${Math.min(candidates.length, MAX_CANDIDATES)} successful transactions with this reference; none paid ${units(amount, req.asset.decimals)} ${req.asset.symbol} to the recipient. Ask the payer for the transaction signature.` };
  }
  return best;
}

async function getSignatures(fetchFn: typeof fetch, reference: string, deadline: number): Promise<string[]> {
  const r = (await rpcPost(fetchFn, SOL_RPC, "getSignaturesForAddress", [reference, { limit: 20, commitment: "confirmed" }], deadline)) as Array<{ signature?: string; err?: unknown }>;
  if (!Array.isArray(r)) throw new Error("bad getSignaturesForAddress response");
  // Failed transactions cannot be payments; dropping them keeps spam from pushing the real payment out.
  return r.filter((item) => item.err == null).map((item) => item.signature).filter((s): s is string => typeof s === "string");
}

async function fetchSolanaTx(fetchFn: typeof fetch, sig: string, deadline: number): Promise<SolanaTx | null> {
  return (await rpcPost(fetchFn, SOL_RPC, "getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }], deadline)) as SolanaTx | null;
}

/** Outcome priority when several transactions carry the reference: one real payment wins over any failure. */
const RANK: Record<VerifyResult["status"], number> = { paid: 5, mismatch: 4, pending: 3, failed: 2, not_found: 1 };

function judgeSolana(req: PaymentRequest, amount: bigint, sig: string, tx: SolanaTx | null | undefined): VerifyResult {
  const { recipient } = req;
  const { decimals, symbol } = req.asset;
  if (tx === null || tx === undefined) return result("pending", sig, "The transaction is not confirmed yet. Try again shortly.");
  if (tx.meta?.err !== null && tx.meta?.err !== undefined) return result("failed", sig, `Transaction ${sig} failed on-chain.`);
  const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === "string" ? k : k?.pubkey));
  if (req.references.length > 0 && !req.references.every((r) => keys.includes(r))) {
    return result("mismatch", sig, `Transaction ${sig} does not carry this link's reference key, so it is not a payment for this link.`);
  }
  const delta = symbol === "SOL" ? solDelta(tx, recipient) : usdcDelta(tx, recipient);
  if (delta >= amount) return result("paid", sig, `Paid: ${units(amount, decimals)} ${symbol} reached ${recipient} in ${sig}.`);
  if (delta > 0n) return result("mismatch", sig, `${units(delta, decimals)} ${symbol} reached ${recipient} in ${sig}, less than the ${units(amount, decimals)} ${symbol} required.`);
  return result("not_found", sig, `Transactions reference this link but none paid ${units(amount, decimals)} ${symbol} to the recipient.`);
}

async function evaluateSolana(req: PaymentRequest, amount: bigint, candidates: string[], fetchFn: typeof fetch, deadline: number): Promise<VerifyResult> {
  const txs = await Promise.all(candidates.map((sig) => fetchSolanaTx(fetchFn, sig, deadline).catch(() => undefined)));
  const outcomes = candidates.map((sig, i) => judgeSolana(req, amount, sig, txs[i]));
  const best = outcomes.reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a));
  // Transactions exist but none moved the asset to the recipient: report a mismatch, not "not found".
  return best.status === "not_found" ? { ...best, status: "mismatch", transaction: null } : best;
}

function solDelta(tx: SolanaTx, recipient: string): bigint {
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const pre = tx.meta?.preBalances ?? [];
  const post = tx.meta?.postBalances ?? [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const pubkey = typeof key === "string" ? key : key?.pubkey;
    if (pubkey === recipient) return BigInt(post[i] ?? 0) - BigInt(pre[i] ?? 0);
  }
  return 0n;
}

function tokenAmount(list: TokenBalance[], recipient: string): bigint {
  let total = 0n;
  for (const b of list) {
    if (b.mint === SOLANA_USDC_MINT && b.owner === recipient) total += BigInt(b.uiTokenAmount?.amount ?? "0");
  }
  return total;
}

function usdcDelta(tx: SolanaTx, recipient: string): bigint {
  return tokenAmount(tx.meta?.postTokenBalances ?? [], recipient) - tokenAmount(tx.meta?.preTokenBalances ?? [], recipient);
}

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

type EvmTx = { to?: string | null; value?: string };
type EvmLog = { address?: string; topics?: string[]; data?: string };
type EvmReceipt = { status?: string; blockNumber?: string; logs?: EvmLog[] } | null;

const REPLAY_NOTE = " Base links carry no reference: record each tx_hash and do not accept it for a second invoice.";

async function verifyBase(req: PaymentRequest, opts: { txHash?: string; minBlock?: number }, amount: bigint, fetchFn: typeof fetch, deadline: number): Promise<VerifyResult> {
  const txHash = opts.txHash;
  if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new PayLinkError("needs_tx_hash", "Pass tx_hash: the Base transaction hash of the payment.");
  }
  const recipient = req.recipient.toLowerCase();
  const decimals = req.asset.decimals;
  const symbol = req.asset.symbol;

  if (symbol === "USDC") {
    const receipt = await getReceipt(fetchFn, txHash, deadline);
    const early = receiptVerdict(receipt, txHash, opts.minBlock);
    if (early) return early;
    const sum = usdcLogsSum(receipt, recipient);
    if (sum >= amount) return result("paid", txHash, `Paid: ${units(amount, decimals)} USDC reached ${req.recipient} in ${txHash}.${REPLAY_NOTE}`);
    if (sum > 0n) return result("mismatch", txHash, `${units(sum, decimals)} USDC reached ${req.recipient} in ${txHash}, less than the ${units(amount, decimals)} USDC required.`);
    return result("mismatch", txHash, `The transaction did not pay ${units(amount, decimals)} USDC to ${req.recipient}.`);
  }

  const [receipt, tx] = await Promise.all([getReceipt(fetchFn, txHash, deadline), getEvmTx(fetchFn, txHash, deadline)]);
  const early = receiptVerdict(receipt, txHash, opts.minBlock);
  if (early) return early;
  const value = tx && typeof tx.value === "string" ? hexToBig(tx.value) : 0n;
  const to = (tx?.to ?? "").toLowerCase();
  if (to === recipient && value >= amount) return result("paid", txHash, `Paid: ${units(amount, decimals)} ETH reached ${req.recipient} in ${txHash}.${REPLAY_NOTE}`);
  if (to === recipient) return result("mismatch", txHash, `${units(value, decimals)} ETH reached ${req.recipient} in ${txHash}, less than the ${units(amount, decimals)} ETH required.`);
  return result("mismatch", txHash, `Only direct ETH transfers can be verified. This transaction was not sent straight to ${req.recipient} (it may have gone through a smart wallet). Check it in a block explorer.`);
}

async function getReceipt(fetchFn: typeof fetch, txHash: string, deadline: number): Promise<EvmReceipt> {
  return (await rpcPost(fetchFn, BASE_RPC, "eth_getTransactionReceipt", [txHash], deadline)) as EvmReceipt;
}

async function getEvmTx(fetchFn: typeof fetch, txHash: string, deadline: number): Promise<EvmTx | null> {
  return (await rpcPost(fetchFn, BASE_RPC, "eth_getTransactionByHash", [txHash], deadline)) as EvmTx | null;
}

function receiptVerdict(receipt: EvmReceipt, txHash: string, minBlock?: number): VerifyResult | null {
  if (receipt === null || receipt === undefined) return result("pending", txHash, "The transaction is not confirmed yet. Try again shortly.");
  if (receipt.status === "0x0") return result("failed", txHash, `Transaction ${txHash} failed on-chain.`);
  const block = receipt.blockNumber ? Number(hexToBig(receipt.blockNumber)) : null;
  if (minBlock !== undefined && block !== null && block < minBlock) {
    return result("mismatch", txHash, `Transaction ${txHash} is in block ${block}, before block ${minBlock}, so it predates this invoice.`);
  }
  return null;
}

function usdcLogsSum(receipt: EvmReceipt, recipient: string): bigint {
  const logs = receipt?.logs ?? [];
  let total = 0n;
  for (const log of logs) {
    if ((log.address ?? "").toLowerCase() !== BASE_USDC.toLowerCase()) continue;
    const topics = log.topics ?? [];
    if (topics[0] !== TRANSFER_TOPIC) continue;
    const value = hexToBig(log.data ?? "0x0");
    if ((topics[2] ?? "").toLowerCase().slice(-40) === recipient.slice(2)) total += value;
    if ((topics[1] ?? "").toLowerCase().slice(-40) === recipient.slice(2)) total -= value;
  }
  return total;
}

function hexToBig(hex: string): bigint {
  try {
    return BigInt(hex);
  } catch {
    return 0n;
  }
}
