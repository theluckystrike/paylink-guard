import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, getAddress } from "viem";
import { buildBaseProposal, checkBaseRecipient, checkBaseSender } from "../src/evm.js";
import { BASE_USDC, PayLinkError } from "../src/types.js";
import type { PaymentRequest } from "../src/types.js";

const RECIPIENT = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const KEY = "io.paybox/transactionProposal";

const USDC_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function baseReq(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    standard: "eip681",
    chain: "base",
    caip2: "eip155:8453",
    asset: { symbol: "ETH", decimals: 18 },
    recipient: RECIPIENT,
    amount: "1.0",
    atomicAmount: "1000000000000000000",
    references: [],
    raw: `ethereum:${RECIPIENT}@8453?value=1e18`,
    ...overrides,
  };
}

function proposal(out: ReturnType<typeof buildBaseProposal>) {
  const p = out.structuredContent[KEY];
  assert.ok(p, "structuredContent must contain the transaction proposal");
  return p;
}

function rpcFake(handlers: Record<string, (params: unknown[]) => string | { error: { code: number; message: string } }>) {
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    calls.push(body.method);
    const handler = handlers[body.method];
    if (!handler) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } }));
    }
    const r = handler(body.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(typeof r === "string" ? { result: r } : r) }));
  };
  return { fetchFn, calls };
}

test("buildBaseProposal: ETH sets recipient, value and chain", () => {
  const out = buildBaseProposal(baseReq(), "1000000000000000000");
  const p = proposal(out);
  assert.equal(p.kind, "evm");
  assert.equal(p.chain, "eip155:8453");
  assert.equal(p.transaction.to, RECIPIENT);
  assert.equal(p.transaction.value, "1000000000000000000");
  assert.equal(p.transaction.data, "0x");
});

test("buildBaseProposal: ETH zero value", () => {
  const p = proposal(buildBaseProposal(baseReq(), "0"));
  assert.equal(p.transaction.value, "0");
});

test("buildBaseProposal: ETH accepts the maximum uint256 value", () => {
  const max = (2n ** 256n - 1n).toString();
  const p = proposal(buildBaseProposal(baseReq(), max));
  assert.equal(p.transaction.value, max);
});

test("buildBaseProposal: ETH rejects value equal to 2^256", () => {
  assert.throws(() => buildBaseProposal(baseReq(), (2n ** 256n).toString()), (e: unknown) => {
    assert.ok(e instanceof PayLinkError);
    assert.equal((e as PayLinkError).code, "invalid_amount");
    return true;
  });
});

test("buildBaseProposal: ETH result carries the boilerplate text", () => {
  const out = buildBaseProposal(baseReq(), "1");
  assert.equal(out.content[0]?.type, "text");
  assert.ok(out.content[0]?.text.includes("Unsigned proposal"));
});

test("buildBaseProposal: USDC targets BASE_USDC with zero value and transfer calldata", () => {
  const req = baseReq({ asset: { symbol: "USDC", decimals: 6, address: BASE_USDC } });
  const out = buildBaseProposal(req, "2500000");
  const p = proposal(out);
  assert.equal(p.transaction.to, BASE_USDC);
  assert.equal(p.transaction.value, "0");
  const decoded = decodeFunctionData({ abi: USDC_ABI, data: p.transaction.data as `0x${string}` });
  assert.equal(decoded.functionName, "transfer");
  assert.equal(decoded.args[0], getAddress(RECIPIENT));
  assert.equal(decoded.args[1], 2500000n);
});

test("buildBaseProposal: USDC encodes a zero transfer", () => {
  const req = baseReq({ asset: { symbol: "USDC", decimals: 6, address: BASE_USDC } });
  const p = proposal(buildBaseProposal(req, "0"));
  const decoded = decodeFunctionData({ abi: USDC_ABI, data: p.transaction.data as `0x${string}` });
  assert.equal(decoded.args[1], 0n);
});

test("buildBaseProposal: USDC encodes a large amount exactly", () => {
  const req = baseReq({ asset: { symbol: "USDC", decimals: 6, address: BASE_USDC } });
  const big = "123456789012345678901234567890";
  const p = proposal(buildBaseProposal(req, big));
  const decoded = decodeFunctionData({ abi: USDC_ABI, data: p.transaction.data as `0x${string}` });
  assert.equal(decoded.args[1], BigInt(big));
});

test("buildBaseProposal: USDC normalizes a lowercase recipient to EIP-55 in calldata", () => {
  const req = baseReq({ asset: { symbol: "USDC", decimals: 6, address: BASE_USDC }, recipient: RECIPIENT.toLowerCase() });
  const p = proposal(buildBaseProposal(req, "1"));
  const decoded = decodeFunctionData({ abi: USDC_ABI, data: p.transaction.data as `0x${string}` });
  assert.equal(decoded.args[0], RECIPIENT);
});

test("buildBaseProposal: normalizes a wrong-checksum recipient to EIP-55", () => {
  const wrongCase = "0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  const p = proposal(buildBaseProposal(baseReq({ recipient: wrongCase }), "1"));
  assert.equal(p.transaction.to, RECIPIENT);
});

test("buildBaseProposal: rejects a malformed recipient", () => {
  assert.throws(() => buildBaseProposal(baseReq({ recipient: "0x1234" }), "1"), (e: unknown) => {
    assert.ok(e instanceof PayLinkError);
    assert.equal((e as PayLinkError).code, "invalid_recipient");
    return true;
  });
});

test("buildBaseProposal: rejects a non-Base chain", () => {
  assert.throws(() => buildBaseProposal(baseReq({ chain: "solana", caip2: "solana:mainnet" }), "1"), (e: unknown) => {
    assert.ok(e instanceof PayLinkError);
    assert.equal((e as PayLinkError).code, "wrong_chain");
    return true;
  });
});

test("buildBaseProposal: rejects a mismatched CAIP-2", () => {
  assert.throws(() => buildBaseProposal(baseReq({ caip2: "solana:mainnet" }), "1"), (e: unknown) => {
    assert.ok(e instanceof PayLinkError);
    assert.equal((e as PayLinkError).code, "wrong_chain");
    return true;
  });
});

test("buildBaseProposal: rejects a SOL asset on Base", () => {
  assert.throws(() => buildBaseProposal(baseReq({ asset: { symbol: "SOL", decimals: 9 } }), "1"), (e: unknown) => {
    assert.ok(e instanceof PayLinkError);
    assert.equal((e as PayLinkError).code, "unsupported_asset");
    return true;
  });
});

test("buildBaseProposal: rejects a negative atomic amount", () => {
  assert.throws(() => buildBaseProposal(baseReq(), "-5"), PayLinkError);
});

test("buildBaseProposal: rejects a fractional atomic amount", () => {
  assert.throws(() => buildBaseProposal(baseReq(), "1.5"), PayLinkError);
});

test("buildBaseProposal: rejects scientific notation in atomic amount", () => {
  assert.throws(() => buildBaseProposal(baseReq(), "1e18"), PayLinkError);
});

test("buildBaseProposal: rejects an empty atomic amount", () => {
  assert.throws(() => buildBaseProposal(baseReq(), ""), PayLinkError);
});

test("buildBaseProposal: rejects leading zeros in atomic amount", () => {
  assert.throws(() => buildBaseProposal(baseReq(), "007"), PayLinkError);
});

test("buildBaseProposal: rejects whitespace around the atomic amount", () => {
  assert.throws(() => buildBaseProposal(baseReq(), " 5"), PayLinkError);
  assert.throws(() => buildBaseProposal(baseReq(), "5 "), PayLinkError);
});

test("buildBaseProposal: rejects a sign prefix on the atomic amount", () => {
  assert.throws(() => buildBaseProposal(baseReq(), "+5"), PayLinkError);
});

test("buildBaseProposal: rejects hexadecimal and unicode atomic amounts", () => {
  assert.throws(() => buildBaseProposal(baseReq(), "0x10"), PayLinkError);
  assert.throws(() => buildBaseProposal(baseReq(), "５"), PayLinkError);
});

test("buildBaseProposal: accepts a 78-digit amount within uint256", () => {
  const value = "1" + "0".repeat(77);
  const p = proposal(buildBaseProposal(baseReq(), value));
  assert.equal(p.transaction.value, value);
});

test("buildBaseProposal: rejects a 78-digit amount above uint256", () => {
  const value = "9".repeat(78);
  assert.throws(() => buildBaseProposal(baseReq(), value), PayLinkError);
});

test("checkBaseRecipient: regular wallet passes type and activity", async () => {
  const { fetchFn } = rpcFake({
    eth_getCode: () => "0x",
    eth_getTransactionCount: () => "0x2a",
    eth_getBalance: () => "0xde0b6b3a7640000",
  });
  const checks = await checkBaseRecipient(RECIPIENT, fetchFn);
  assert.deepEqual(
    checks.map((c) => [c.id, c.status]),
    [
      ["base_recipient_type", "pass"],
      ["base_recipient_activity", "pass"],
    ],
  );
});

test("checkBaseRecipient: smart contract yields a type warn", async () => {
  const { fetchFn } = rpcFake({
    eth_getCode: () => "0x6080604052",
    eth_getTransactionCount: () => "0x1",
    eth_getBalance: () => "0x0",
  });
  const checks = await checkBaseRecipient(RECIPIENT, fetchFn);
  assert.equal(checks[0]?.status, "warn");
  assert.match(checks[0]?.detail ?? "", /^Recipient is a smart contract/);
});

test("checkBaseRecipient: no transactions, no ETH and no USDC yields activity warn", async () => {
  const { fetchFn } = rpcFake({
    eth_getCode: () => "0x",
    eth_getTransactionCount: () => "0x0",
    eth_getBalance: () => "0x0",
    eth_call: () => "0x" + "0".repeat(64),
  });
  const checks = await checkBaseRecipient(RECIPIENT, fetchFn);
  assert.equal(checks[1]?.status, "warn");
  assert.equal(checks[1]?.detail, "Recipient has no transactions, no ETH and no USDC on Base. Check that the address is correct.");
});

test("checkBaseRecipient: a receive-only merchant holding only USDC passes activity", async () => {
  const { fetchFn } = rpcFake({
    eth_getCode: () => "0x",
    eth_getTransactionCount: () => "0x0",
    eth_getBalance: () => "0x0",
    eth_call: () => "0x" + (125_000_000).toString(16).padStart(64, "0"),
  });
  const checks = await checkBaseRecipient(RECIPIENT, fetchFn);
  assert.equal(checks[1]?.status, "pass");
  assert.match(checks[1]?.detail ?? "", /USDC balance/);
});

test("checkBaseRecipient: EIP-7702 delegated wallet is a wallet, not a contract", async () => {
  const { fetchFn } = rpcFake({
    eth_getCode: () => "0xef0100" + "ab".repeat(20),
    eth_getTransactionCount: () => "0x3",
    eth_getBalance: () => "0x0",
    eth_call: () => "0x" + "0".repeat(64),
  });
  const checks = await checkBaseRecipient(RECIPIENT, fetchFn);
  assert.equal(checks[0]?.status, "pass");
  assert.match(checks[0]?.detail ?? "", /EIP-7702/);
});

test("checkBaseRecipient: the USDC token contract as recipient is a block, with no RPC calls", async () => {
  const { fetchFn, calls } = rpcFake({});
  const checks = await checkBaseRecipient("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", fetchFn);
  assert.deepEqual(checks.map((c) => c.status), ["fail"]);
  assert.match(checks[0]?.detail ?? "", /USDC token contract/);
  assert.equal(calls.length, 0);
});

test("checkBaseRecipient: zero address and 0x...dEaD are blocked", async () => {
  for (const a of ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dEaD"]) {
    const { fetchFn } = rpcFake({});
    const checks = await checkBaseRecipient(a, fetchFn);
    assert.equal(checks[0]?.status, "fail", a);
    assert.match(checks[0]?.detail ?? "", /burn address/);
  }
});

test("checkBaseRecipient: zero balance with a transaction still passes activity", async () => {
  const { fetchFn } = rpcFake({
    eth_getCode: () => "0x",
    eth_getTransactionCount: () => "0x5",
    eth_getBalance: () => "0x0",
  });
  const checks = await checkBaseRecipient(RECIPIENT, fetchFn);
  assert.equal(checks[1]?.status, "pass");
});

test("checkBaseRecipient: HTTP error gives unknown for both checks", async () => {
  const fetchFn: typeof fetch = async () => new Response("boom", { status: 500 });
  const checks = await checkBaseRecipient(RECIPIENT, fetchFn);
  assert.ok(checks.every((c) => c.status === "unknown"));
});

test("checkBaseRecipient: RPC error object gives unknown", async () => {
  const fetchFn: typeof fetch = async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "bad" } }));
  const checks = await checkBaseRecipient(RECIPIENT, fetchFn);
  assert.ok(checks.every((c) => c.status === "unknown"));
});

test("checkBaseRecipient: fetch rejection gives unknown", async () => {
  const fetchFn: typeof fetch = async () => {
    throw new Error("network down");
  };
  const checks = await checkBaseRecipient(RECIPIENT, fetchFn);
  assert.ok(checks.every((c) => c.status === "unknown"));
});

test("checkBaseRecipient: non-string RPC result gives unknown", async () => {
  const fetchFn: typeof fetch = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));
  const checks = await checkBaseRecipient(RECIPIENT, fetchFn);
  assert.ok(checks.every((c) => c.status === "unknown"));
});

test("checkBaseRecipient: invalid address throws PayLinkError", async () => {
  await assert.rejects(() => checkBaseRecipient("not-an-address", async () => new Response()), (e: unknown) => {
    assert.ok(e instanceof PayLinkError);
    assert.equal((e as PayLinkError).code, "invalid_recipient");
    return true;
  });
});

test("checkBaseRecipient: posts JSON-RPC with a timeout signal", async () => {
  let sawSignal = false;
  const fetchFn: typeof fetch = async (_input, init) => {
    sawSignal = init?.signal instanceof AbortSignal;
    const body = JSON.parse(String(init?.body)) as { method: string };
    const results: Record<string, string> = {
      eth_getCode: "0x",
      eth_getTransactionCount: "0x1",
      eth_getBalance: "0x1",
    };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: results[body.method] }));
  };
  await checkBaseRecipient(RECIPIENT, fetchFn);
  assert.ok(sawSignal);
});

test("checkBaseRecipient: runs the six RPC calls in parallel", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchFn: typeof fetch = async (_input, init) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    const results: Record<string, string> = {
      eth_getCode: "0x",
      eth_getTransactionCount: "0x1",
      eth_getBalance: "0x1",
      eth_call: "0x" + "0".repeat(64),
    };
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: results[body.method] }));
  };
  await checkBaseRecipient(RECIPIENT, fetchFn);
  assert.equal(maxInFlight, 6);
});

test("checkBaseRecipient: requests exactly the six expected methods", async () => {
  const { fetchFn, calls } = rpcFake({
    eth_getCode: () => "0x",
    eth_getTransactionCount: () => "0x1",
    eth_getBalance: () => "0x1",
    eth_call: () => "0x" + "0".repeat(64),
  });
  await checkBaseRecipient(RECIPIENT, fetchFn);
  assert.deepEqual([...new Set(calls)].sort(), ["eth_call", "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getTransactionCount"]);
});

test("checkBaseSender: USDC below the amount fails with both numbers", async () => {
  const { fetchFn } = rpcFake({ eth_getBalance: () => "0x2386f26fc10000", eth_call: () => "0x" + (3_000_000).toString(16).padStart(64, "0") });
  const req = { ...baseReq(), asset: { symbol: "USDC" as const, decimals: 6, address: BASE_USDC } };
  const check = await checkBaseSender(req, "19990000", RECIPIENT, fetchFn);
  assert.equal(check.status, "fail");
  assert.match(check.detail, /has 3 USDC on Base\. The link asks for 19\.99 USDC/);
});

test("checkBaseSender: enough USDC but zero ETH for gas fails", async () => {
  const { fetchFn } = rpcFake({ eth_getBalance: () => "0x0", eth_call: () => "0x" + (50_000_000).toString(16).padStart(64, "0") });
  const req = { ...baseReq(), asset: { symbol: "USDC" as const, decimals: 6, address: BASE_USDC } };
  const check = await checkBaseSender(req, "19990000", RECIPIENT, fetchFn);
  assert.equal(check.status, "fail");
  assert.match(check.detail, /a little ETH for gas/);
});

test("checkBaseSender: ETH payment needs more than the amount", async () => {
  const { fetchFn } = rpcFake({ eth_getBalance: () => "0x" + (10n ** 15n).toString(16) });
  const check = await checkBaseSender(baseReq(), (10n ** 15n).toString(), RECIPIENT, fetchFn);
  assert.equal(check.status, "fail");
});

test("checkBaseSender: funded wallet passes; RPC failure is unknown", async () => {
  const ok = rpcFake({ eth_getBalance: () => "0x2386f26fc10000", eth_call: () => "0x" + (50_000_000).toString(16).padStart(64, "0") });
  const req = { ...baseReq(), asset: { symbol: "USDC" as const, decimals: 6, address: BASE_USDC } };
  assert.equal((await checkBaseSender(req, "19990000", RECIPIENT, ok.fetchFn)).status, "pass");
  const bad = rpcFake({});
  assert.equal((await checkBaseSender(req, "19990000", RECIPIENT, bad.fetchFn)).status, "unknown");
});

test("checkBaseRecipient: Coinbase Smart Wallet (proxy code + implementation slot) passes", async () => {
  const { fetchFn } = rpcFake({
    eth_getCode: () => "0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3",
    eth_getStorageAt: () => "0x000000000000000000000000000100abaad02f1cfc8bbe32bd5a564817339e72",
    eth_getTransactionCount: () => "0x1",
    eth_getBalance: () => "0x0",
  });
  const checks = await checkBaseRecipient(RECIPIENT, fetchFn);
  assert.equal(checks[0]?.status, "pass");
  assert.equal(checks[0]?.detail, "Recipient is a Coinbase Smart Wallet.");
});

test("checkBaseRecipient: the same proxy code with another implementation stays a contract warn", async () => {
  const { fetchFn } = rpcFake({
    eth_getCode: () => "0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3",
    eth_getStorageAt: () => "0x000000000000000000000000" + "ab".repeat(20),
    eth_getTransactionCount: () => "0x1",
    eth_getBalance: () => "0x0",
  });
  assert.equal((await checkBaseRecipient(RECIPIENT, fetchFn))[0]?.status, "warn");
});

test("checkBaseRecipient: Safe proxy with a known singleton in slot 0 passes; unknown singleton warns", async () => {
  const safe = (slot0: string) => rpcFake({
    eth_getCode: () => "0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e00000000",
    eth_getStorageAt: () => slot0,
    eth_getTransactionCount: () => "0x1",
    eth_getBalance: () => "0x0",
  });
  const ok = await checkBaseRecipient(RECIPIENT, safe("0x00000000000000000000000041675c099f32341bf84bfc5382af534df5c7461a").fetchFn);
  assert.equal(ok[0]?.detail, "Recipient is a Safe multisig wallet.");
  const unknown = await checkBaseRecipient(RECIPIENT, safe("0x000000000000000000000000" + "cd".repeat(20)).fetchFn);
  assert.equal(unknown[0]?.status, "warn");
});

test("checkBaseRecipient: '1 sent transaction' is singular", async () => {
  const { fetchFn } = rpcFake({ eth_getCode: () => "0x", eth_getTransactionCount: () => "0x1", eth_getBalance: () => "0x0" });
  assert.match((await checkBaseRecipient(RECIPIENT, fetchFn))[1]?.detail ?? "", /\(1 sent transaction\)/);
});
