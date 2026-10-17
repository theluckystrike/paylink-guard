import { PublicKey } from "@solana/web3.js";
import { getAddress, isAddress } from "viem";

import { BASE_USDC, PayLinkError, SOLANA_USDC_MINT } from "./types.js";
import type { Asset, PaymentRequest } from "./types.js";

const ETH_DECIMALS = 18;
const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;
const MAX_DECIMAL_LEN = 256;
const MAX_ATOMIC_LEN = 512;
const MAX_LINK_LEN = 4096;
const UNPAYABLE_EVM = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead", BASE_USDC.toLowerCase()]);

export interface PaymentLinkInput {
  chain: "base" | "solana";
  asset: "ETH" | "USDC" | "SOL";
  recipient: string;
  amount: string;
  label?: string;
  message?: string;
  memo?: string;
  reference?: string[];
}

function unsupported(message: string): PayLinkError {
  return new PayLinkError("unsupported", message);
}

function invalidAmount(message: string): PayLinkError {
  return new PayLinkError("invalid_amount", message);
}

function normalizeEvmAddress(value: unknown): string {
  if (typeof value !== "string") {
    throw unsupported("Recipient must be a hexadecimal Ethereum address.");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw unsupported("Recipient must be a valid 20-byte hexadecimal address.");
  }
  // EIP-55: all-lowercase and all-uppercase carry no checksum. Mixed case is a checksum and must match,
  // because a mismatch usually means a mistyped or altered address.
  const hex = value.slice(2);
  const mixed = /[a-f]/.test(hex) && /[A-F]/.test(hex);
  if (mixed && !isAddress(value, { strict: true })) {
    throw new PayLinkError("bad_checksum", "The address checksum does not match. The address may be mistyped or altered. Ask the merchant for a new link.");
  }
  return getAddress(value.toLowerCase());
}

function solanaKeyOrThrow(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw unsupported("Solana recipient and references must be base58 public keys.");
  }
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw unsupported("Solana recipient and references must be valid base58 32-byte public keys.");
  }
}

function decodeFormValue(value: string, plusAsSpace = true): string {
  try {
    return decodeURIComponent(plusAsSpace ? value.replace(/\+/g, " ") : value);
  } catch {
    throw unsupported("Link contains invalid percent-encoding.");
  }
}

type Params = Record<string, string[]>;

function parseQuery(query: string, plusAsSpace = true): Params {
  const out: Params = {};
  if (query === "") return out;
  for (const segment of query.split("&")) {
    if (segment === "") continue;
    const eq = segment.indexOf("=");
    const rawKey = eq === -1 ? segment : segment.slice(0, eq);
    const rawValue = eq === -1 ? "" : segment.slice(eq + 1);
    const key = decodeFormValue(rawKey, plusAsSpace);
    const value = decodeFormValue(rawValue, plusAsSpace);
    (out[key] ??= []).push(value);
  }
  return out;
}

function single(params: Params, key: string): string | undefined {
  const values = params[key];
  if (values === undefined) return undefined;
  if (values.length > 1) {
    throw unsupported(`The "${key}" parameter appears more than once.`);
  }
  return values[0];
}

/**
 * Refuse unknown parameters. A misspelled or upper-case key (SPL-TOKEN, spl_token) would otherwise be ignored,
 * and a USDC link would silently become a native SOL or ETH payment.
 */
function allowOnly(params: Params, allowed: readonly string[], standard: string): void {
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) {
      throw new PayLinkError("unknown_parameter", `The link has an unknown ${standard} parameter "${key}". Ask the merchant for a standard link.`);
    }
  }
}

function multi(params: Params, key: string): string[] {
  return params[key] ?? [];
}

export function toAtomic(decimal: string, decimals: number): string {
  if (typeof decimal !== "string") throw invalidAmount("Amount must be a string.");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw invalidAmount("Token decimals must be an integer from 0 to 255.");
  }
  if (decimal.length === 0 || decimal.length > MAX_DECIMAL_LEN || !/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(decimal)) {
    throw invalidAmount("Amount must be a non-negative decimal with no sign, leading zeros, or scientific notation.");
  }
  const [whole, fraction = ""] = decimal.split(".");
  if (fraction.length > decimals) {
    throw invalidAmount(`Amount has ${fraction.length} decimal places; this asset supports ${decimals}.`);
  }
  return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`).toString();
}

export function fromAtomic(atomic: string, decimals: number): string {
  if (typeof atomic !== "string") throw invalidAmount("Atomic amount must be a string.");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw invalidAmount("Token decimals must be an integer from 0 to 255.");
  }
  if (atomic.length === 0 || atomic.length > MAX_ATOMIC_LEN || !/^(0|[1-9][0-9]*)$/.test(atomic)) {
    throw invalidAmount("Atomic amount must be a non-negative integer with no sign or leading zeros.");
  }
  if (decimals === 0) return atomic;
  if (atomic === "0") return "0";
  const padded = atomic.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

function parseAtomicInteger(input: string): string {
  if (input.length === 0 || input.length > MAX_ATOMIC_LEN) {
    throw invalidAmount("Amount must resolve to a non-negative integer.");
  }
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(input);
  if (!m) throw invalidAmount("Amount must be a non-negative number that resolves to a whole number.");
  const intPart = m[1]!;
  const fracPart = m[2] ?? "";
  const expPart = m[3] ?? "0";
  const value = BigInt(intPart + fracPart);
  const shift = BigInt(expPart) - BigInt(fracPart.length);
  if (shift > 100n || shift < -100n) throw invalidAmount("Amount exponent is out of range.");
  if (shift >= 0n) {
    const result = value * (10n ** shift);
    if (result >= 2n ** 256n) throw invalidAmount("Amount is larger than a uint256.");
    return result.toString();
  }
  const divisor = 10n ** -shift;
  if (value % divisor !== 0n) throw invalidAmount("EIP-681 amounts are in the smallest unit (wei, or 10^-6 USDC) and must be whole numbers. Ask the merchant for a corrected link.");
  return (value / divisor).toString();
}

function parseEip681(raw: string, rest: string): PaymentRequest {
  const qIdx = rest.indexOf("?");
  const path = qIdx === -1 ? rest : rest.slice(0, qIdx);
  const params = parseQuery(qIdx === -1 ? "" : rest.slice(qIdx + 1), false);

  // EIP-681: the optional "pay-" prefix marks a payment request and does not change the meaning.
  let p = path;
  if (p.startsWith("pay-")) p = p.slice("pay-".length);

  const slashIdx = p.indexOf("/");
  let func: string | null = null;
  if (slashIdx !== -1) {
    func = p.slice(slashIdx + 1);
    p = p.slice(0, slashIdx);
  }

  const atIdx = p.indexOf("@");
  const target = atIdx === -1 ? p : p.slice(0, atIdx);
  const chainId = atIdx === -1 ? null : p.slice(atIdx + 1);

  if (chainId === null || !/^\d+$/.test(chainId) || BigInt(chainId) !== 8453n) {
    throw new PayLinkError("unsupported_chain", "Only Base (chain 8453) is supported. Ask the merchant for a Base link.");
  }

  if (func === null) return parseNativeEth(raw, target, params);
  if (func !== "transfer") throw unsupported(`Unsupported EIP-681 function "${func}".`);
  return parseUsdcTransfer(raw, target, params);
}

function textParams(params: Params): { label?: string; message?: string } {
  const label = single(params, "label");
  const message = single(params, "message");
  return { ...(label !== undefined ? { label } : {}), ...(message !== undefined ? { message } : {}) };
}

function parseNativeEth(raw: string, target: string, params: Params): PaymentRequest {
  allowOnly(params, ["value", "label", "message", "gas", "gasLimit", "gasPrice"], "EIP-681");
  const recipient = normalizeEvmAddress(target);
  const valueRaw = single(params, "value");
  const atomicAmount = valueRaw === undefined ? null : parseAtomicInteger(valueRaw);
  return {
    standard: "eip681",
    chain: "base",
    caip2: "eip155:8453",
    asset: { symbol: "ETH", decimals: ETH_DECIMALS },
    recipient,
    amount: atomicAmount === null ? null : fromAtomic(atomicAmount, ETH_DECIMALS),
    atomicAmount,
    ...textParams(params),
    references: [],
    raw,
  };
}

function parseUsdcTransfer(raw: string, target: string, params: Params): PaymentRequest {
  // No "value" here: ETH sent along with a token transfer would go to the token contract and be lost.
  allowOnly(params, ["address", "uint256", "label", "message", "gas", "gasLimit", "gasPrice"], "EIP-681");
  if (target.toLowerCase() !== BASE_USDC.toLowerCase()) {
    throw new PayLinkError("unsupported_token", "Only Base USDC is supported. Ask the merchant for a USDC link.");
  }
  const addressRaw = single(params, "address");
  if (addressRaw === undefined) throw unsupported("A USDC transfer link must include an address parameter.");
  const recipient = normalizeEvmAddress(addressRaw);
  const uintRaw = single(params, "uint256");
  if (uintRaw === undefined) throw unsupported("A USDC transfer link must include a uint256 parameter.");
  const atomicAmount = parseAtomicInteger(uintRaw);
  return {
    standard: "eip681",
    chain: "base",
    caip2: "eip155:8453",
    asset: { symbol: "USDC", decimals: USDC_DECIMALS, address: BASE_USDC },
    recipient,
    amount: fromAtomic(atomicAmount, USDC_DECIMALS),
    atomicAmount,
    ...textParams(params),
    references: [],
    raw,
  };
}

function parseSolanaPay(raw: string, rest: string): PaymentRequest {
  const qIdx = rest.indexOf("?");
  const recipientRaw = qIdx === -1 ? rest : rest.slice(0, qIdx);
  const params = parseQuery(qIdx === -1 ? "" : rest.slice(qIdx + 1));

  if (/^https?:\/\//i.test(recipientRaw)) {
    throw unsupported("Interactive Solana Pay transaction requests are not supported.");
  }
  const recipient = solanaKeyOrThrow(recipientRaw);
  allowOnly(params, ["amount", "spl-token", "reference", "label", "message", "memo"], "Solana Pay");

  const mint = single(params, "spl-token");
  let asset: Asset;
  if (mint === undefined) {
    asset = { symbol: "SOL", decimals: SOL_DECIMALS };
  } else if (mint === SOLANA_USDC_MINT) {
    asset = { symbol: "USDC", decimals: USDC_DECIMALS, address: SOLANA_USDC_MINT };
  } else {
    throw new PayLinkError("unsupported_token", "Only SOL and USDC are supported. Ask the merchant for a supported token.");
  }

  const amountRaw = single(params, "amount");
  let amount: string | null = null;
  let atomicAmount: string | null = null;
  if (amountRaw !== undefined) {
    atomicAmount = toAtomic(amountRaw, asset.decimals);
    amount = fromAtomic(atomicAmount, asset.decimals);
  }

  const references = multi(params, "reference").map((r) => solanaKeyOrThrow(r));
  if (new Set(references).size !== references.length) throw unsupported("The link repeats a reference key.");
  if (references.length > 8) throw unsupported("The link has more than 8 reference keys.");
  if (references.includes(recipient)) throw unsupported("A reference key cannot be the recipient.");
  const label = single(params, "label");
  const message = single(params, "message");
  const memo = single(params, "memo");
  if (memo !== undefined && Buffer.byteLength(memo, "utf8") > 500) {
    throw unsupported("The memo is longer than 500 bytes and does not fit in one Solana transaction. Ask the merchant for a shorter memo.");
  }

  return {
    standard: "solana-pay",
    chain: "solana",
    caip2: "solana:mainnet",
    asset,
    recipient,
    amount,
    atomicAmount,
    ...(label !== undefined ? { label } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(memo !== undefined ? { memo } : {}),
    references,
    raw,
  };
}

export function parsePaymentLink(uri: string): PaymentRequest {
  if (typeof uri !== "string") throw unsupported("Payment link must be a string.");
  const raw = uri.trim();
  if (raw === "") throw unsupported("Payment link is empty.");
  if (raw.length > MAX_LINK_LEN) throw unsupported(`Payment link is longer than ${MAX_LINK_LEN} characters.`);
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(raw);
  if (!m) throw unsupported("Payment link must start with ethereum: or solana:.");
  const scheme = m[1]!.toLowerCase();
  const rest = raw.slice(m[0].length);
  if (scheme === "ethereum") return parseEip681(raw, rest);
  if (scheme === "solana") return parseSolanaPay(raw, rest);
  throw unsupported(`Unsupported payment scheme "${scheme}".`);
}

const enc = encodeURIComponent;

const ASSETS: Record<"base" | "solana", Partial<Record<PaymentLinkInput["asset"], Asset>>> = {
  base: { ETH: { symbol: "ETH", decimals: ETH_DECIMALS }, USDC: { symbol: "USDC", decimals: USDC_DECIMALS, address: BASE_USDC } },
  solana: { SOL: { symbol: "SOL", decimals: SOL_DECIMALS }, USDC: { symbol: "USDC", decimals: USDC_DECIMALS, address: SOLANA_USDC_MINT } },
};

function optionalText(input: PaymentLinkInput, keys: readonly ("label" | "message" | "memo")[]): string[] {
  return keys.flatMap((k) => (input[k] === undefined ? [] : [`${k}=${enc(input[k]!)}`]));
}

/** Validate the builder input shape and return the asset for its chain. */
function buildAsset(input: PaymentLinkInput): Asset {
  if (typeof input !== "object" || input === null) throw unsupported("buildPaymentLink requires an input object.");
  if (typeof input.amount !== "string" || input.amount.length === 0) throw invalidAmount("Provide a non-empty amount string.");
  if (input.reference !== undefined && !Array.isArray(input.reference)) throw unsupported("reference must be an array of public keys.");
  const chainAssets = input.chain === "base" || input.chain === "solana" ? ASSETS[input.chain] : undefined;
  if (chainAssets === undefined) throw unsupported(`Unsupported chain "${String(input.chain)}".`);
  const asset = chainAssets[input.asset];
  if (asset === undefined) throw unsupported(`${String(input.asset)} is not available on ${input.chain === "base" ? "Base" : "Solana"}.`);
  return asset;
}

export function buildPaymentLink(input: PaymentLinkInput): string {
  const asset = buildAsset(input);
  const references = input.reference ?? [];
  const atomic = toAtomic(input.amount, asset.decimals);
  if (atomic === "0") throw invalidAmount("Amount must be greater than zero.");

  if (input.chain === "base") {
    if (input.memo !== undefined || references.length > 0) throw unsupported("memo and reference are Solana Pay fields. Remove them for a Base link.");
    const to = normalizeEvmAddress(input.recipient);
    if (UNPAYABLE_EVM.has(to.toLowerCase())) throw unsupported("That recipient is a burn address or the USDC contract. Use the merchant's wallet address.");
    const text = optionalText(input, ["label", "message"]);
    if (asset.symbol === "ETH") return `ethereum:${to}@8453?${[`value=${atomic}`, ...text].join("&")}`;
    return `ethereum:${BASE_USDC}@8453/transfer?${[`address=${to}`, `uint256=${atomic}`, ...text].join("&")}`;
  }

  const to = solanaKeyOrThrow(input.recipient);
  const q = [`amount=${fromAtomic(atomic, asset.decimals)}`];
  if (asset.symbol === "USDC") q.push(`spl-token=${SOLANA_USDC_MINT}`);
  for (const r of references) q.push(`reference=${solanaKeyOrThrow(r)}`);
  return `solana:${to}?${[...q, ...optionalText(input, ["label", "message", "memo"])].join("&")}`;
}

export function resolveAmount(req: PaymentRequest, overrideAmount?: string): { amount: string; atomic: string } {
  if (req.amount !== null && req.atomicAmount !== null) {
    if (overrideAmount !== undefined && overrideAmount !== "" && toAtomic(overrideAmount, req.asset.decimals) !== req.atomicAmount) {
      throw new PayLinkError("amount_conflict", `The link fixes the amount at ${req.amount} ${req.asset.symbol}. Do not pass a different amount.`);
    }
    return { amount: req.amount, atomic: req.atomicAmount };
  }
  if (typeof overrideAmount !== "string" || overrideAmount.length === 0) {
    throw new PayLinkError("missing_amount", "This link has no amount. Provide an amount to pay.");
  }
  const atomic = toAtomic(overrideAmount, req.asset.decimals);
  return { amount: fromAtomic(atomic, req.asset.decimals), atomic };
}
