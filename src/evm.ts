import { encodeFunctionData, getAddress } from "viem";
import { proposeEvm } from "./paybox.js";
import { rpcPost } from "./net.js";
import { BASE_USDC, HOSTS, PayLinkError } from "./types.js";
import type { Check, PaymentRequest } from "./types.js";

const ERC20_TRANSFER_ABI = [
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

function normalizeAddress(addr: string): `0x${string}` {
  if (typeof addr !== "string") {
    throw new PayLinkError("invalid_recipient", "Recipient must be a valid Base address.");
  }
  try {
    return getAddress(addr);
  } catch {
    throw new PayLinkError("invalid_recipient", "Recipient must be a valid Base address.");
  }
}

function parseAtomic(atomic: string): bigint {
  if (typeof atomic !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(atomic)) {
    throw new PayLinkError("invalid_amount", "Amount must be a non-negative integer string in atomic units.");
  }
  const value = BigInt(atomic);
  if (value >= 2n ** 256n) {
    throw new PayLinkError("invalid_amount", "Amount exceeds uint256.");
  }
  return value;
}

export function buildBaseProposal(req: PaymentRequest, atomic: string) {
  if (req.chain !== "base" || req.caip2 !== "eip155:8453") {
    throw new PayLinkError("wrong_chain", "This link is not on Base. Use the Solana tool for Solana links.");
  }
  const recipient = normalizeAddress(req.recipient);
  const amount = parseAtomic(atomic);

  if (req.asset.symbol === "ETH") {
    return proposeEvm({ chain: "eip155:8453", to: recipient, value: amount.toString() });
  }
  if (req.asset.symbol === "USDC") {
    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [recipient, amount],
    });
    return proposeEvm({ chain: "eip155:8453", to: BASE_USDC, value: "0", data });
  }
  throw new PayLinkError("unsupported_asset", "Only ETH and USDC are supported on Base.");
}

async function rpc(fetchFn: typeof fetch, method: string, params: unknown[]): Promise<string> {
  const result = await rpcPost(fetchFn, [HOSTS.baseRpc, HOSTS.baseRpcFallback], method, params);
  if (typeof result !== "string") throw new Error("RPC response missing result");
  return result;
}

async function attempt(fn: () => Promise<string>): Promise<{ ok: boolean; value?: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false };
  }
}

function hexQuantityToBigInt(hex: string): bigint | null {
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) return null;
  try {
    return BigInt(hex);
  } catch {
    return null;
  }
}

/** Addresses that can never be a merchant: funds sent there are lost. Lowercase. */
const DEAD_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
  BASE_USDC.toLowerCase(),
]);

/** ERC-20 balanceOf(address) call data for the USDC activity probe. */
function balanceOfData(address: string): string {
  return `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

export async function checkBaseRecipient(addr: string, fetchFn: typeof fetch = fetch): Promise<Check[]> {
  const address = normalizeAddress(addr);
  if (DEAD_ADDRESSES.has(address.toLowerCase())) {
    const what = address.toLowerCase() === BASE_USDC.toLowerCase() ? "the USDC token contract" : "a burn address";
    return [{ id: "base_recipient_type", status: "fail", detail: `Recipient is ${what}. Funds sent there are lost. Ask the merchant for their wallet address.` }];
  }
  const [code, count, balance, usdc, implSlot, slot0] = await Promise.all([
    attempt(() => rpc(fetchFn, "eth_getCode", [address, "latest"])),
    attempt(() => rpc(fetchFn, "eth_getTransactionCount", [address, "latest"])),
    attempt(() => rpc(fetchFn, "eth_getBalance", [address, "latest"])),
    attempt(() => rpc(fetchFn, "eth_call", [{ to: BASE_USDC, data: balanceOfData(address) }, "latest"])),
    attempt(() => rpc(fetchFn, "eth_getStorageAt", [address, ERC1967_IMPL_SLOT, "latest"])),
    attempt(() => rpc(fetchFn, "eth_getStorageAt", [address, "0x0", "latest"])),
  ]);

  const value = (r: { ok: boolean; value?: string }) => (r.ok && r.value !== undefined ? r.value : null);
  const usdcRaw = value(usdc);
  return [
    typeCheck(value(code), value(implSlot), value(slot0)),
    activityCheck(
      value(count) === null ? null : hexQuantityToBigInt(value(count)!),
      value(balance) === null ? null : hexQuantityToBigInt(value(balance)!),
      usdcRaw === null || usdcRaw === "0x" ? null : hexQuantityToBigInt(usdcRaw),
    ),
  ];
}

/** ERC-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1. */
const ERC1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
/** Coinbase Smart Wallet: ERC-1967 minimal proxy runtime code and its implementation. */
const CSW_PROXY_CODE = "0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3";
const CSW_IMPL = "000100abaad02f1cfc8bbe32bd5a564817339e72";
/** Safe singletons (v1.3.0, v1.3.0-L2, v1.3.0 eip155, v1.3.0-L2 eip155, v1.4.1, v1.4.1-L2), stored in proxy slot 0. */
const SAFE_SINGLETONS = new Set([
  "d9db270c1b5e3bd161e8c8503c55ceabee709552", "3e5c63644e683549055b9be8653de26e0b4cd36e",
  "69f4d1788e39c87893c980c06edf4b7f686e2938", "fb1bffc9d739b8d520daf37df666da4c687191ea",
  "41675c099f32341bf84bfc5382af534df5c7461a", "29fcb43b46531bca003ddc8fcb67ffe91900c762",
]);
/** Safe proxy runtime code contains the masterCopy() selector. */
const SAFE_PROXY_MARKER = "a619486e";

function slotAddress(slot: string | null): string {
  return slot !== null && /^0x[0-9a-fA-F]{64}$/.test(slot) ? slot.slice(-40).toLowerCase() : "";
}

function typeCheck(code: string | null, implSlot: string | null = null, slot0: string | null = null): Check {
  const id = "base_recipient_type";
  if (code === null) return { id, status: "unknown", detail: "Could not determine the recipient type on Base." };
  const lower = code.toLowerCase();
  if (lower === "0x") return { id, status: "pass", detail: "Recipient is a regular wallet." };
  // EIP-7702: a regular wallet that delegates to code. The owner still holds the key.
  if (/^0xef0100[0-9a-f]{40}$/.test(lower)) return { id, status: "pass", detail: "Recipient is a regular wallet with an EIP-7702 delegation." };
  if (lower === CSW_PROXY_CODE && slotAddress(implSlot) === CSW_IMPL) return { id, status: "pass", detail: "Recipient is a Coinbase Smart Wallet." };
  if (lower.includes(SAFE_PROXY_MARKER) && SAFE_SINGLETONS.has(slotAddress(slot0))) return { id, status: "pass", detail: "Recipient is a Safe multisig wallet." };
  return { id, status: "warn", detail: "Recipient is a smart contract (for example a smart wallet or a payment contract). Confirm the merchant expects payment to a contract." };
}

function activityCheck(nonce: bigint | null, eth: bigint | null, usdcBalance: bigint | null): Check {
  const id = "base_recipient_activity";
  const parts = [
    nonce !== null && nonce > 0n ? `${nonce} sent transaction${nonce === 1n ? "" : "s"}` : null,
    eth !== null && eth > 0n ? "an ETH balance" : null,
    usdcBalance !== null && usdcBalance > 0n ? "a USDC balance" : null,
  ].filter((part): part is string => part !== null);
  if (parts.length > 0) return { id, status: "pass", detail: `Recipient is in use on Base (${parts.join(", ")}).` };
  if (nonce !== null && eth !== null && usdcBalance !== null) {
    return { id, status: "warn", detail: "Recipient has no transactions, no ETH and no USDC on Base. Check that the address is correct." };
  }
  return { id, status: "unknown", detail: "Could not determine the recipient activity on Base." };
}


/** About 20 Base USDC transfers' worth of gas at typical fees. */
const GAS_MARGIN_WEI = 10_000_000_000_000n;

function units(atomic: bigint, decimals: number): string {
  const s = atomic.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, "");
}

/**
 * Check that the paying wallet can cover the payment: the asset amount, plus some ETH for gas.
 * PayBox simulation would only report "reverted"; this names the missing balance instead.
 */
export async function checkBaseSender(req: PaymentRequest, atomic: string, sender: string, fetchFn: typeof fetch = fetch): Promise<Check> {
  const id = "base_sender_balance";
  const address = normalizeAddress(sender);
  const [eth, usdc] = await Promise.all([
    attempt(() => rpc(fetchFn, "eth_getBalance", [address, "latest"])),
    req.asset.symbol === "USDC" ? attempt(() => rpc(fetchFn, "eth_call", [{ to: BASE_USDC, data: balanceOfData(address) }, "latest"])) : Promise.resolve({ ok: true, value: "0x0" }),
  ]);
  const ethBal = eth.ok && eth.value !== undefined ? hexQuantityToBigInt(eth.value) : null;
  const usdcBal = usdc.ok && usdc.value !== undefined && usdc.value !== "0x" ? hexQuantityToBigInt(usdc.value) : null;
  if (ethBal === null || usdcBal === null) return { id, status: "unknown", detail: "Could not check your wallet balance on Base." };
  const amount = BigInt(atomic);
  if (req.asset.symbol === "USDC" && usdcBal < amount) {
    return { id, status: "fail", detail: `Your wallet has ${units(usdcBal, 6)} USDC on Base. The link asks for ${units(amount, 6)} USDC.` };
  }
  const needEth = (req.asset.symbol === "ETH" ? amount : 0n) + GAS_MARGIN_WEI;
  if (ethBal < needEth) {
    return { id, status: "fail", detail: `Your wallet has ${units(ethBal, 18)} ETH on Base. It needs ${req.asset.symbol === "ETH" ? `more than ${units(amount, 18)} ETH (amount plus gas)` : "a little ETH for gas"}.` };
  }
  return { id, status: "pass", detail: `Your wallet can cover this payment and gas on Base.` };
}
