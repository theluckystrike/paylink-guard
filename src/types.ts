// Shared contract for PayLink Guard. Owned by the orchestrator. Workers import, never edit.
export type Chain = "base" | "solana";
export type AssetSymbol = "ETH" | "USDC" | "SOL";

export interface Asset {
  symbol: AssetSymbol;
  decimals: number;
  /** ERC-20 contract (Base USDC) or SPL mint (Solana USDC). Absent for native ETH and SOL. */
  address?: string;
}

/** A payment request normalized from an EIP-681 or Solana Pay URI. Amounts are exact strings. */
export interface PaymentRequest {
  standard: "eip681" | "solana-pay";
  chain: Chain;
  /** CAIP-2: "eip155:8453" or "solana:mainnet". */
  caip2: "eip155:8453" | "solana:mainnet";
  asset: Asset;
  recipient: string;
  /** Decimal string in whole units (e.g. "1.25"), or null when the link has no amount. */
  amount: string | null;
  /** Integer string in atomic units, or null when the link has no amount. */
  atomicAmount: string | null;
  label?: string;
  message?: string;
  memo?: string;
  /** Solana Pay reference public keys, in link order. */
  references: string[];
  /** The input URI, trimmed. */
  raw: string;
}

export type CheckStatus = "pass" | "warn" | "fail" | "unknown";
export interface Check {
  id: string;
  status: CheckStatus;
  /** One short sentence for a human. */
  detail: string;
}
export type Verdict = "ok" | "caution" | "block";

/** Thrown by parsers and builders for invalid or unsupported input. The message is shown to the user. */
export class PayLinkError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "PayLinkError"; }
}

export const BASE_CHAIN_ID = 8453;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const HOSTS = {
  baseRpc: "https://mainnet.base.org",
  baseRpcFallback: "https://base-rpc.publicnode.com",
  /** Public keyless endpoint first: the official one rate-limits shared sandbox IPs (HTTP 429). */
  solanaRpc: "https://solana-rpc.publicnode.com",
  solanaRpcFallback: "https://api.mainnet-beta.solana.com",
  goplus: "https://api.gopluslabs.io",
} as const;
/** Per-attempt network timeout. Worst case is two attempts (6 s); the tool budget is 10 s. */
export const FETCH_TIMEOUT_MS = 3000;
