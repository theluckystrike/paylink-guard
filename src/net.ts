import { FETCH_TIMEOUT_MS } from "./types.js";

/**
 * POST a JSON-RPC body to each URL in order and return the first well-formed JSON-RPC result.
 * A timeout, HTTP error (including 429) or JSON-RPC error moves on to the next URL. Throws only when all fail.
 */
export async function rpcPost(fetchFn: typeof fetch, urls: readonly string[], method: string, params: unknown[], deadline = Infinity): Promise<unknown> {
  let last: unknown = new Error("no RPC URL");
  for (const url of urls) {
    // Never start an attempt that cannot finish before the caller's deadline (the hosted budget is 10 s).
    const left = deadline - Date.now();
    if (left < 300) break;
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, left)),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { error?: unknown; result?: unknown };
      if (json.error !== undefined || !("result" in json)) throw new Error("JSON-RPC error");
      return json.result;
    } catch (err) {
      last = err;
    }
  }
  throw last;
}
