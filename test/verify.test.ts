import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyPayment } from "../src/verify.js";
import { BASE_USDC, PayLinkError, SOLANA_USDC_MINT } from "../src/types.js";
import type { PaymentRequest } from "../src/types.js";

const SOL_RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BASE_RECIPIENT = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const BASE_RECIPIENT_LOWER = BASE_RECIPIENT.toLowerCase();
const SIG = "someSignatureString123";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TX_HASH = "0x" + "ab".repeat(32);

function solReq(asset: "SOL" | "USDC", overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    standard: "solana-pay",
    chain: "solana",
    caip2: "solana:mainnet",
    asset: asset === "SOL" ? { symbol: "SOL", decimals: 9 } : { symbol: "USDC", decimals: 6, address: SOLANA_USDC_MINT },
    recipient: SOL_RECIPIENT,
    amount: null,
    atomicAmount: null,
    references: [],
    raw: `solana:${SOL_RECIPIENT}`,
    ...overrides,
  };
}

function baseReq(asset: "ETH" | "USDC", overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    standard: "eip681",
    chain: "base",
    caip2: "eip155:8453",
    asset: asset === "ETH" ? { symbol: "ETH", decimals: 18 } : { symbol: "USDC", decimals: 6, address: BASE_USDC },
    recipient: BASE_RECIPIENT,
    amount: null,
    atomicAmount: null,
    references: [],
    raw: `ethereum:${BASE_RECIPIENT}`,
    ...overrides,
  };
}

type Handler = (params: unknown[]) => unknown;

function rpcFake(handlers: Record<string, Handler>) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fetchFn = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    calls.push({ method: body.method, params: body.params });
    const handler = handlers[body.method];
    if (!handler) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } }));
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: handler(body.params) }));
  }) as typeof fetch;
  return { fetchFn, calls };
}

// Solana fixtures -----------------------------------------------------------

function solSolTx(recipient: string, delta: number, err: unknown = null): unknown {
  return {
    meta: {
      err,
      fee: 5000,
      preBalances: [0, 1_000_000_000],
      postBalances: [delta, 1_000_000_000],
      preTokenBalances: [],
      postTokenBalances: [],
    },
    transaction: {
      message: { accountKeys: [{ pubkey: recipient }, { pubkey: "Sysvar1111111111111111111111111111111111111" }] },
      signatures: [SIG],
    },
  };
}

function solUsdcTx(recipient: string, postAmount: number, err: unknown = null, preAmount = 0): unknown {
  const balance = (amount: number) => ({ mint: SOLANA_USDC_MINT, owner: recipient, uiTokenAmount: { amount: String(amount), decimals: 6 } });
  return {
    meta: {
      err,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      preTokenBalances: preAmount === 0 ? [] : [balance(preAmount)],
      postTokenBalances: [balance(postAmount)],
    },
    transaction: { message: { accountKeys: [{ pubkey: recipient }] } },
  };
}

function signatureList(signatures: string[]): unknown {
  return signatures.map((signature) => ({ signature }));
}

// Base fixtures -------------------------------------------------------------

function pad64(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}
function topic2For(addr: string): string {
  return "0x" + "0".repeat(24) + addr.slice(2).toLowerCase();
}
function transferLog(address: string, recipient: string, amount: bigint): unknown {
  return { address, topics: [TRANSFER_TOPIC, pad64(0n), topic2For(recipient)], data: pad64(amount) };
}
function receipt(status: "0x1" | "0x0", logs: unknown[] = []): unknown {
  return { status, logs };
}

// ---------------------------------------------------------------------------
// Solana SOL
// ---------------------------------------------------------------------------

test("SOL: paid when the transfer covers the amount", async () => {
  const { fetchFn } = rpcFake({ getTransaction: () => solSolTx(SOL_RECIPIENT, 1_000_000_000) });
  const req = solReq("SOL", { atomicAmount: "1000000000", amount: "1" });
  const out = await verifyPayment(req, { signature: SIG }, fetchFn);
  assert.deepEqual({ status: out.status, verified: out.verified, transaction: out.transaction }, { status: "paid", verified: true, transaction: SIG });
  assert.equal(out.detail, `Paid: 1 SOL reached ${SOL_RECIPIENT} in ${SIG}.`);
});

test("SOL: underpaid transfer is a mismatch with both numbers", async () => {
  const { fetchFn } = rpcFake({ getTransaction: () => solSolTx(SOL_RECIPIENT, 500_000_000) });
  const req = solReq("SOL", { atomicAmount: "1000000000", amount: "1" });
  const out = await verifyPayment(req, { signature: SIG }, fetchFn);
  assert.equal(out.status, "mismatch");
  assert.equal(out.verified, false);
  assert.equal(out.transaction, SIG);
  assert.match(out.detail, /0\.5 SOL/);
  assert.match(out.detail, /1 SOL required/);
});

test("SOL: a failed transaction reports failed", async () => {
  const { fetchFn } = rpcFake({ getTransaction: () => solSolTx(SOL_RECIPIENT, 1_000_000_000, { InstructionError: [0, "Custom"] }) });
  const req = solReq("SOL", { atomicAmount: "1000000000" });
  const out = await verifyPayment(req, { signature: SIG }, fetchFn);
  assert.equal(out.status, "failed");
  assert.equal(out.transaction, SIG);
});

test("SOL: a missing transaction is pending", async () => {
  const { fetchFn } = rpcFake({ getTransaction: () => null });
  const req = solReq("SOL", { atomicAmount: "1000000000" });
  const out = await verifyPayment(req, { signature: SIG }, fetchFn);
  assert.equal(out.status, "pending");
  assert.equal(out.transaction, SIG);
});

test("SOL: no transaction for the reference is not_found", async () => {
  const ref = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const { fetchFn } = rpcFake({ getSignaturesForAddress: () => [] });
  const req = solReq("SOL", { atomicAmount: "1000000000", references: [ref] });
  const out = await verifyPayment(req, {}, fetchFn);
  assert.equal(out.status, "not_found");
  assert.equal(out.detail, "No successful transaction with this reference yet.");
});

// ---------------------------------------------------------------------------
// Solana USDC
// ---------------------------------------------------------------------------

test("USDC (Solana): paid when the token delta covers the amount", async () => {
  const { fetchFn } = rpcFake({ getTransaction: () => solUsdcTx(SOL_RECIPIENT, 19_990_000) });
  const req = solReq("USDC", { atomicAmount: "19990000", amount: "19.99" });
  const out = await verifyPayment(req, { signature: SIG }, fetchFn);
  assert.equal(out.status, "paid");
  assert.equal(out.detail, `Paid: 19.99 USDC reached ${SOL_RECIPIENT} in ${SIG}.`);
});

test("USDC (Solana): net delta below the amount is a mismatch", async () => {
  const { fetchFn } = rpcFake({ getTransaction: () => solUsdcTx(SOL_RECIPIENT, 3_000_000) });
  const req = solReq("USDC", { atomicAmount: "19990000", amount: "19.99" });
  const out = await verifyPayment(req, { signature: SIG }, fetchFn);
  assert.equal(out.status, "mismatch");
  assert.match(out.detail, /3 USDC/);
  assert.match(out.detail, /19\.99 USDC required/);
});

test("USDC (Solana): a failed transaction reports failed", async () => {
  const { fetchFn } = rpcFake({ getTransaction: () => solUsdcTx(SOL_RECIPIENT, 19_990_000, "SomeError") });
  const req = solReq("USDC", { atomicAmount: "19990000" });
  const out = await verifyPayment(req, { signature: SIG }, fetchFn);
  assert.equal(out.status, "failed");
});

test("USDC (Solana): a missing transaction is pending", async () => {
  const { fetchFn } = rpcFake({ getTransaction: () => null });
  const req = solReq("USDC", { atomicAmount: "19990000" });
  const out = await verifyPayment(req, { signature: SIG }, fetchFn);
  assert.equal(out.status, "pending");
});

test("USDC (Solana): empty reference history is not_found", async () => {
  const { fetchFn } = rpcFake({ getSignaturesForAddress: () => [] });
  const req = solReq("USDC", { atomicAmount: "19990000", references: [SOL_RECIPIENT] });
  const out = await verifyPayment(req, {}, fetchFn);
  assert.equal(out.status, "not_found");
});

// ---------------------------------------------------------------------------
// Base USDC
// ---------------------------------------------------------------------------

test("USDC (Base): a matching Transfer log pays", async () => {
  const { fetchFn } = rpcFake({
    eth_getTransactionReceipt: () => receipt("0x1", [transferLog(BASE_USDC, BASE_RECIPIENT, 19_990_000n)]),
  });
  const req = baseReq("USDC", { atomicAmount: "19990000", amount: "19.99" });
  const out = await verifyPayment(req, { txHash: TX_HASH }, fetchFn);
  assert.equal(out.status, "paid");
  assert.equal(out.transaction, TX_HASH);
  assert.equal(out.detail, `Paid: 19.99 USDC reached ${BASE_RECIPIENT} in ${TX_HASH}. Base links carry no reference: record each tx_hash and do not accept it for a second invoice.`);
});

test("USDC (Base): multiple Transfer logs are summed", async () => {
  const { fetchFn } = rpcFake({
    eth_getTransactionReceipt: () => receipt("0x1", [
      transferLog(BASE_USDC, BASE_RECIPIENT, 10_000_000n),
      transferLog(BASE_USDC, BASE_RECIPIENT, 9_990_000n),
    ]),
  });
  const req = baseReq("USDC", { atomicAmount: "19990000" });
  const out = await verifyPayment(req, { txHash: TX_HASH }, fetchFn);
  assert.equal(out.status, "paid");
});

test("USDC (Base): a Transfer from another token contract is ignored", async () => {
  const other = "0x000000000000000000000000000000000000beef";
  const { fetchFn } = rpcFake({
    eth_getTransactionReceipt: () => receipt("0x1", [transferLog(other, BASE_RECIPIENT, 99_999_999_999n)]),
  });
  const req = baseReq("USDC", { atomicAmount: "19990000" });
  const out = await verifyPayment(req, { txHash: TX_HASH }, fetchFn);
  assert.equal(out.status, "mismatch");
  assert.match(out.detail, /did not pay 19\.99 USDC/);
});

test("USDC (Base): a partial payment is a mismatch with both numbers", async () => {
  const { fetchFn } = rpcFake({
    eth_getTransactionReceipt: () => receipt("0x1", [transferLog(BASE_USDC, BASE_RECIPIENT, 3_000_000n)]),
  });
  const req = baseReq("USDC", { atomicAmount: "19990000", amount: "19.99" });
  const out = await verifyPayment(req, { txHash: TX_HASH }, fetchFn);
  assert.equal(out.status, "mismatch");
  assert.match(out.detail, /3 USDC/);
  assert.match(out.detail, /19\.99 USDC required/);
});

test("USDC (Base): a reverted transaction reports failed", async () => {
  const { fetchFn } = rpcFake({ eth_getTransactionReceipt: () => receipt("0x0") });
  const req = baseReq("USDC", { atomicAmount: "19990000" });
  const out = await verifyPayment(req, { txHash: TX_HASH }, fetchFn);
  assert.equal(out.status, "failed");
  assert.equal(out.transaction, TX_HASH);
});

test("USDC (Base): a missing receipt is pending", async () => {
  const { fetchFn } = rpcFake({ eth_getTransactionReceipt: () => null });
  const req = baseReq("USDC", { atomicAmount: "19990000" });
  const out = await verifyPayment(req, { txHash: TX_HASH }, fetchFn);
  assert.equal(out.status, "pending");
});

// ---------------------------------------------------------------------------
// Base ETH
// ---------------------------------------------------------------------------

function ethTx(to: string, value: bigint): unknown {
  return { to, value: "0x" + value.toString(16) };
}

test("ETH (Base): a transaction to the recipient with enough value pays", async () => {
  const { fetchFn } = rpcFake({
    eth_getTransactionReceipt: () => receipt("0x1"),
    eth_getTransactionByHash: () => ethTx(BASE_RECIPIENT_LOWER, 10n ** 18n),
  });
  const req = baseReq("ETH", { atomicAmount: "1000000000000000000", amount: "1" });
  const out = await verifyPayment(req, { txHash: TX_HASH }, fetchFn);
  assert.equal(out.status, "paid");
  assert.equal(out.detail, `Paid: 1 ETH reached ${BASE_RECIPIENT} in ${TX_HASH}. Base links carry no reference: record each tx_hash and do not accept it for a second invoice.`);
});

test("ETH (Base): value below the amount is a mismatch with both numbers", async () => {
  const { fetchFn } = rpcFake({
    eth_getTransactionReceipt: () => receipt("0x1"),
    eth_getTransactionByHash: () => ethTx(BASE_RECIPIENT_LOWER, 5n * 10n ** 17n),
  });
  const req = baseReq("ETH", { atomicAmount: "1000000000000000000", amount: "1" });
  const out = await verifyPayment(req, { txHash: TX_HASH }, fetchFn);
  assert.equal(out.status, "mismatch");
  assert.match(out.detail, /0\.5 ETH/);
  assert.match(out.detail, /1 ETH required/);
});

test("ETH (Base): a transaction to another address is a mismatch", async () => {
  const { fetchFn } = rpcFake({
    eth_getTransactionReceipt: () => receipt("0x1"),
    eth_getTransactionByHash: () => ethTx("0x0000000000000000000000000000000000001234", 10n ** 18n),
  });
  const req = baseReq("ETH", { atomicAmount: "1000000000000000000" });
  const out = await verifyPayment(req, { txHash: TX_HASH }, fetchFn);
  assert.equal(out.status, "mismatch");
});

test("ETH (Base): a reverted transaction reports failed", async () => {
  const { fetchFn } = rpcFake({
    eth_getTransactionReceipt: () => receipt("0x0"),
    eth_getTransactionByHash: () => ethTx(BASE_RECIPIENT_LOWER, 10n ** 18n),
  });
  const req = baseReq("ETH", { atomicAmount: "1000000000000000000" });
  const out = await verifyPayment(req, { txHash: TX_HASH }, fetchFn);
  assert.equal(out.status, "failed");
});

test("ETH (Base): a missing receipt is pending", async () => {
  const { fetchFn } = rpcFake({
    eth_getTransactionReceipt: () => null,
    eth_getTransactionByHash: () => ethTx(BASE_RECIPIENT_LOWER, 10n ** 18n),
  });
  const req = baseReq("ETH", { atomicAmount: "1000000000000000000" });
  const out = await verifyPayment(req, { txHash: TX_HASH }, fetchFn);
  assert.equal(out.status, "pending");
});

test("ETH (Base): receipt and transaction calls run in parallel", async () => {
  let inFlight = 0;
  let max = 0;
  const fetchFn = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    inFlight++;
    max = Math.max(max, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    if (body.method === "eth_getTransactionReceipt") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: receipt("0x1") }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: ethTx(BASE_RECIPIENT_LOWER, 10n ** 18n) }));
  }) as typeof fetch;
  const req = baseReq("ETH", { atomicAmount: "1000000000000000000" });
  await verifyPayment(req, { txHash: TX_HASH }, fetchFn);
  assert.equal(max, 2);
});

// ---------------------------------------------------------------------------
// Reference with several signatures
// ---------------------------------------------------------------------------

test("reference: the 2nd of 3 signatures pays", async () => {
  const bySig: Record<string, unknown> = {
    s1: solUsdcTx(SOL_RECIPIENT, 0),
    s2: solUsdcTx(SOL_RECIPIENT, 19_990_000),
    s3: solUsdcTx(SOL_RECIPIENT, 0),
  };
  const { fetchFn } = rpcFake({
    getSignaturesForAddress: () => signatureList(["s1", "s2", "s3"]),
    getTransaction: (params) => bySig[params[0] as string],
  });
  const req = solReq("USDC", { atomicAmount: "19990000", amount: "19.99", references: [SOL_RECIPIENT] });
  const out = await verifyPayment(req, {}, fetchFn);
  assert.equal(out.status, "paid");
  assert.equal(out.transaction, "s2");
});

test("reference: three signatures where none pay is a mismatch", async () => {
  const { fetchFn } = rpcFake({
    getSignaturesForAddress: () => signatureList(["s1", "s2", "s3"]),
    getTransaction: () => solUsdcTx(SOL_RECIPIENT, 0),
  });
  const req = solReq("USDC", { atomicAmount: "19990000", amount: "19.99", references: [SOL_RECIPIENT] });
  const out = await verifyPayment(req, {}, fetchFn);
  assert.equal(out.status, "mismatch");
  assert.equal(out.detail, `Checked the latest 3 successful transactions with this reference; none paid 19.99 USDC to the recipient. Ask the payer for the transaction signature.`);
});

// ---------------------------------------------------------------------------
// Bad input
// ---------------------------------------------------------------------------

test("Base: a malformed tx hash throws needs_tx_hash", async () => {
  const req = baseReq("ETH", { atomicAmount: "1000000000000000000" });
  await assert.rejects(() => verifyPayment(req, { txHash: "0xzz" }, fetch), (e: unknown) => {
    assert.ok(e instanceof PayLinkError);
    assert.equal((e as PayLinkError).code, "needs_tx_hash");
    return true;
  });
});

test("Base: a missing tx hash throws needs_tx_hash", async () => {
  const req = baseReq("ETH", { atomicAmount: "1000000000000000000" });
  await assert.rejects(() => verifyPayment(req, {}, fetch), (e: unknown) => {
    assert.ok(e instanceof PayLinkError);
    assert.equal((e as PayLinkError).code, "needs_tx_hash");
    return true;
  });
});

test("Solana: no reference and no signature throws needs_reference", async () => {
  const req = solReq("SOL", { atomicAmount: "1000000000", references: [] });
  await assert.rejects(() => verifyPayment(req, {}, fetch), (e: unknown) => {
    assert.ok(e instanceof PayLinkError);
    assert.equal((e as PayLinkError).code, "needs_reference");
    return true;
  });
});

test("a link with no amount throws missing_amount", async () => {
  const req = solReq("SOL", { atomicAmount: null, references: [SOL_RECIPIENT] });
  await assert.rejects(() => verifyPayment(req, {}, fetch), (e: unknown) => {
    assert.ok(e instanceof PayLinkError);
    assert.equal((e as PayLinkError).code, "missing_amount");
    return true;
  });
});

// ---------------------------------------------------------------------------
// Network failure
// ---------------------------------------------------------------------------

test("an RPC outage returns pending, never throws", async () => {
  const fetchFn = (async () => new Response("busy", { status: 429 })) as typeof fetch;
  const req = solReq("SOL", { atomicAmount: "1000000000", references: [SOL_RECIPIENT] });
  const out = await verifyPayment(req, {}, fetchFn);
  assert.equal(out.status, "pending");
  assert.equal(out.detail, "Could not reach the Solana RPC. Try again.");
});

test("an RPC outage on Base returns the Base pending detail", async () => {
  const fetchFn = (async () => new Response("busy", { status: 429 })) as typeof fetch;
  const req = baseReq("ETH", { atomicAmount: "1000000000000000000" });
  const out = await verifyPayment(req, { txHash: TX_HASH }, fetchFn);
  assert.equal(out.status, "pending");
  assert.equal(out.detail, "Could not reach the Base RPC. Try again.");
});

test("Solana: a paid transaction wins over an earlier failed or pending one", async () => {
  const { Keypair } = await import("@solana/web3.js");
  const recipient = Keypair.generate().publicKey.toBase58();
  const reference = Keypair.generate().publicKey.toBase58();
  const req = {
    standard: "solana-pay" as const, chain: "solana" as const, caip2: "solana:mainnet" as const,
    asset: { symbol: "SOL" as const, decimals: 9 }, recipient, amount: "1", atomicAmount: "1000000000",
    references: [reference], raw: `solana:${recipient}?amount=1&reference=${reference}`,
  };
  const txs: Record<string, unknown> = {
    s1: { meta: { err: { InstructionError: [0, "x"] }, preBalances: [0, 0], postBalances: [0, 0] }, transaction: { message: { accountKeys: [{ pubkey: "a" }, { pubkey: recipient }] } } },
    s2: null,
    s3: { meta: { err: null, preBalances: [5_000_000_000, 0, 0], postBalances: [3_999_995_000, 1_000_000_000, 0] }, transaction: { message: { accountKeys: [{ pubkey: "a" }, { pubkey: recipient }, { pubkey: reference }] } } },
  };
  const fetchFn = (async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    const result = body.method === "getSignaturesForAddress" ? [{ signature: "s1" }, { signature: "s2" }, { signature: "s3" }] : txs[body.params[0] as string] ?? null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  }) as typeof fetch;
  const r = await verifyPayment(req, {}, fetchFn);
  assert.equal(r.status, "paid");
  assert.equal(r.transaction, "s3");
});

// ---------------------------------------------------------------------------
// R1 re-check regressions (N2 to N6)
// ---------------------------------------------------------------------------

function routed(handlers: Record<string, (params: unknown[]) => unknown>) {
  return (async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    const h = handlers[body.method];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: h ? h(body.params) : null }));
  }) as typeof fetch;
}

test("N2: a Solana signature without the link's reference key is not a payment for this link", async () => {
  const { Keypair } = await import("@solana/web3.js");
  const recipient = Keypair.generate().publicKey.toBase58();
  const reference = Keypair.generate().publicKey.toBase58();
  const req = { standard: "solana-pay" as const, chain: "solana" as const, caip2: "solana:mainnet" as const, asset: { symbol: "SOL" as const, decimals: 9 }, recipient, amount: "1", atomicAmount: "1000000000", references: [reference], raw: "x" };
  const tx = { meta: { err: null, preBalances: [5_000_000_000, 0], postBalances: [3_999_995_000, 1_000_000_000] }, transaction: { message: { accountKeys: [{ pubkey: "a" }, { pubkey: recipient }] } } };
  const r = await verifyPayment(req, { signature: "s".repeat(88) }, routed({ getTransaction: () => tx }));
  assert.equal(r.status, "mismatch");
  assert.match(r.detail, /does not carry this link's reference key/);
});

test("N4: failed spam transactions on the reference are skipped and up to 8 candidates are checked", async () => {
  const { Keypair } = await import("@solana/web3.js");
  const recipient = Keypair.generate().publicKey.toBase58();
  const reference = Keypair.generate().publicKey.toBase58();
  const req = { standard: "solana-pay" as const, chain: "solana" as const, caip2: "solana:mainnet" as const, asset: { symbol: "SOL" as const, decimals: 9 }, recipient, amount: "1", atomicAmount: "1000000000", references: [reference], raw: "x" };
  const empty = { meta: { err: null, preBalances: [1, 0, 0], postBalances: [1, 0, 0] }, transaction: { message: { accountKeys: [{ pubkey: "a" }, { pubkey: recipient }, { pubkey: reference }] } } };
  const paid = { meta: { err: null, preBalances: [5_000_000_000, 0, 0], postBalances: [3_999_995_000, 1_000_000_000, 0] }, transaction: { message: { accountKeys: [{ pubkey: "a" }, { pubkey: recipient }, { pubkey: reference }] } } };
  const sigs = [{ signature: "f1", err: { x: 1 } }, ...["e1", "e2", "e3", "e4", "e5"].map((s) => ({ signature: s, err: null })), { signature: "p1", err: null }];
  const r = await verifyPayment(req, {}, routed({ getSignaturesForAddress: () => sigs, getTransaction: (p) => (p[0] === "p1" ? paid : empty) }));
  assert.equal(r.status, "paid");
  assert.equal(r.transaction, "p1");
});

test("N5: Base USDC that comes back to the payer in the same transaction does not count", async () => {
  const pad = (a: string) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
  const T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const payer = "0x1111111111111111111111111111111111111111";
  const amountHex = "0x" + (5_000_000).toString(16).padStart(64, "0");
  const receipt = { status: "0x1", blockNumber: "0x10", logs: [
    { address: BASE_USDC, topics: [T, pad(payer), pad(BASE_RECIPIENT)], data: amountHex },
    { address: BASE_USDC, topics: [T, pad(BASE_RECIPIENT), pad(payer)], data: amountHex },
  ] };
  const req = { ...baseReq("USDC", { atomicAmount: "19990000", amount: "19.99" }), atomicAmount: "5000000", amount: "5" };
  const r = await verifyPayment(req, { txHash: TX_HASH }, routed({ eth_getTransactionReceipt: () => receipt }));
  assert.equal(r.status, "mismatch");
});

test("Base min_block refuses a receipt from before the invoice", async () => {
  const T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const pad = (a: string) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
  const receipt = { status: "0x1", blockNumber: "0x64", logs: [{ address: BASE_USDC, topics: [T, pad("0x1111111111111111111111111111111111111111"), pad(BASE_RECIPIENT)], data: "0x" + (19_990_000).toString(16).padStart(64, "0") }] };
  const r = await verifyPayment(baseReq("USDC", { atomicAmount: "19990000", amount: "19.99" }), { txHash: TX_HASH, minBlock: 101 }, routed({ eth_getTransactionReceipt: () => receipt }));
  assert.equal(r.status, "mismatch");
  assert.match(r.detail, /predates this invoice/);
  const ok = await verifyPayment(baseReq("USDC", { atomicAmount: "19990000", amount: "19.99" }), { txHash: TX_HASH, minBlock: 100 }, routed({ eth_getTransactionReceipt: () => receipt }));
  assert.equal(ok.status, "paid");
});

test("N6: ETH sent through a contract is not reported as unpaid", async () => {
  const req = { ...baseReq("USDC", { atomicAmount: "19990000", amount: "19.99" }), asset: { symbol: "ETH" as const, decimals: 18 }, atomicAmount: "1000000000000000", amount: "0.001" };
  const r = await verifyPayment(req, { txHash: TX_HASH }, routed({
    eth_getTransactionReceipt: () => ({ status: "0x1", blockNumber: "0x1", logs: [] }),
    eth_getTransactionByHash: () => ({ to: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", value: "0x0" }),
  }));
  assert.equal(r.status, "mismatch");
  assert.match(r.detail, /Only direct ETH transfers can be verified/);
  assert.doesNotMatch(r.detail, /did not pay/);
});
