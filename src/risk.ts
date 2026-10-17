import { HOSTS, FETCH_TIMEOUT_MS } from "./types.js";
import type { Check, Verdict } from "./types.js";

/** The id reported on every check produced by this module. */
const GPLUS_ID = "goplus_security";

/**
 * GoPlus address_security risk fields that, when "1", mark the address as
 * flagged. Order is preserved so the fail detail lists them as the spec lists them.
 */
const GPLUS_FLAGS = [
  "cybercrime",
  "money_laundering",
  "financial_crime",
  "darkweb_transactions",
  "phishing_activities",
  "stealing_attack",
  "blackmail_activities",
  "sanctioned",
  "malicious_mining_activities",
  "mixer",
  "honeypot_related_address",
  "fake_kyc",
] as const;

/** "Suspected" only: warn instead of block, so one weak signal cannot stop a real merchant payment. */
const GPLUS_SOFT_FLAGS = ["blacklist_doubt"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Query GoPlus address_security for a Base address and reduce it to a single
 * risk Check. Never throws: invalid input, network failure, timeouts, non-JSON
 * bodies, or unexpected shapes all yield status "unknown".
 */
export async function checkGoPlus(addr: string, fetchFn: typeof fetch = fetch): Promise<Check> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return { id: GPLUS_ID, status: "unknown", detail: "Invalid recipient address for the GoPlus security check." };
  }

  const url = `${HOSTS.goplus}/api/v1/address_security/${addr}?chain_id=8453`;
  let body: unknown;
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { id: GPLUS_ID, status: "unknown", detail: "GoPlus security check unavailable." };
    body = await res.json();
  } catch {
    return { id: GPLUS_ID, status: "unknown", detail: "GoPlus security check unavailable." };
  }

  if (!isRecord(body) || body.code !== 1 || !isRecord(body.result)) {
    return { id: GPLUS_ID, status: "unknown", detail: "GoPlus security check unavailable." };
  }

  const result = body.result;
  const isSet = (field: string) => String(result[field]) === "1";
  const flagged: string[] = GPLUS_FLAGS.filter(isSet);
  // A count, not a flag: an address that deployed malicious contracts (for example scam tokens).
  const created = Number(result.number_of_malicious_contracts_created ?? 0);
  if (Number.isSafeInteger(created) && created > 0) flagged.push(`number_of_malicious_contracts_created=${created}`);
  const soft = GPLUS_SOFT_FLAGS.filter(isSet);
  if (flagged.length > 0) {
    return { id: GPLUS_ID, status: "fail", detail: `Security flags in GoPlus: ${[...flagged, ...soft].join(", ")}.` };
  }
  if (soft.length > 0) {
    return { id: GPLUS_ID, status: "warn", detail: `GoPlus marks this address as suspected (${soft.join(", ")}). Confirm the address with the merchant.` };
  }

  const source = typeof result.data_source === "string" ? result.data_source.trim() : "";
  return { id: GPLUS_ID, status: "pass", detail: source ? `No security flags in GoPlus (sources: ${source}).` : "No security flags in GoPlus." };
}

/** Reduce a set of checks to a single verdict plus the non-pass details, in order. */
export function verdict(checks: Check[]): { verdict: Verdict; reasons: string[] } {
  const reasons = checks.filter((check) => check.status !== "pass").map((check) => check.detail);
  let result: Verdict = "ok";
  if (checks.some((check) => check.status === "fail")) result = "block";
  else if (checks.some((check) => check.status !== "pass")) result = "caution";
  return { verdict: result, reasons };
}
