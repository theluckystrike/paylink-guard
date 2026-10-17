import { test } from "node:test";
import assert from "node:assert/strict";
import { checkGoPlus, verdict } from "../src/risk.js";

const ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

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
  "blacklist_doubt",
] as const;

function cleanResult() {
  const r: Record<string, string> = { data_source: "SlowMist,BlockSec" };
  for (const f of GPLUS_FLAGS) r[f] = "0";
  return r;
}

type Call = { url: RequestInfo | URL; init?: RequestInit };

/** Fake fetch that records its calls and returns a JSON (or raw) body. */
function captureFetch(body: unknown, opts: { status?: number; raw?: string } = {}) {
  const calls: Call[] = [];
  const fn = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url, init });
    const text = opts.raw ?? (typeof body === "string" ? body : JSON.stringify(body));
    return new Response(text, { status: opts.status ?? 200 });
  };
  return { calls, fn };
}

function throwingFetch(error: Error) {
  return async () => {
    throw error;
  };
}

test("checkGoPlus passes on an all-zero result and reports the data_source", async () => {
  const { fn } = captureFetch({ code: 1, message: "ok", result: cleanResult() });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.id, "goplus_security");
  assert.equal(check.status, "pass");
  assert.equal(check.detail, "No security flags in GoPlus (sources: SlowMist,BlockSec).");
});

test("checkGoPlus fails when cybercrime is 1", async () => {
  const result = cleanResult();
  result.cybercrime = "1";
  const { fn } = captureFetch({ code: 1, message: "ok", result });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "fail");
  assert.equal(check.detail, "Security flags in GoPlus: cybercrime.");
});

test("checkGoPlus fails when sanctioned is 1", async () => {
  const result = cleanResult();
  result.sanctioned = "1";
  const { fn } = captureFetch({ code: 1, message: "ok", result });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "fail");
  assert.equal(check.detail, "Security flags in GoPlus: sanctioned.");
});

test("checkGoPlus lists multiple flags in spec order, not result order", async () => {
  const result: Record<string, string> = { mixer: "1", cybercrime: "1", data_source: "X" };
  for (const f of GPLUS_FLAGS) if (result[f] === undefined) result[f] = "0";
  const { fn } = captureFetch({ code: 1, message: "ok", result });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "fail");
  assert.equal(check.detail, "Security flags in GoPlus: cybercrime, mixer.");
});

test("every hard flag independently produces a fail", async () => {
  for (const flag of GPLUS_FLAGS.filter((f) => f !== "blacklist_doubt")) {
    const result = cleanResult();
    result[flag] = "1";
    const { fn } = captureFetch({ code: 1, message: "ok", result });
    const check = await checkGoPlus(ADDR, fn);
    assert.equal(check.status, "fail", `${flag} should fail`);
    assert.ok(check.detail.includes(flag), `${flag} should be named in the detail`);
  }
});

test("checkGoPlus is unknown when code is 0", async () => {
  const { fn } = captureFetch({ code: 0, message: "fail", result: cleanResult() });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "unknown");
});

test("checkGoPlus is unknown when code is a string '1'", async () => {
  const { fn } = captureFetch({ code: "1", message: "ok", result: cleanResult() });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "unknown");
});

test("checkGoPlus is unknown when code is missing", async () => {
  const { fn } = captureFetch({ message: "ok", result: cleanResult() });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "unknown");
});

test("checkGoPlus is unknown when result is missing", async () => {
  const { fn } = captureFetch({ code: 1, message: "ok" });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "unknown");
});

test("checkGoPlus is unknown when result is null", async () => {
  const { fn } = captureFetch({ code: 1, message: "ok", result: null });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "unknown");
});

test("checkGoPlus is unknown when result is an array", async () => {
  const { fn } = captureFetch({ code: 1, message: "ok", result: [1, 2, 3] });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "unknown");
});

test("checkGoPlus is unknown when the body is a JSON string", async () => {
  const { fn } = captureFetch({}, { raw: '"hello"' });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "unknown");
});

test("checkGoPlus is unknown when the body is a JSON number", async () => {
  const { fn } = captureFetch({}, { raw: "42" });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "unknown");
});

test("checkGoPlus is unknown on HTTP 404", async () => {
  const { fn } = captureFetch({ code: 1, message: "ok", result: cleanResult() }, { status: 404 });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "unknown");
});

test("checkGoPlus is unknown on HTTP 500", async () => {
  const { fn } = captureFetch({}, { status: 500, raw: "boom" });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "unknown");
});

test("checkGoPlus is unknown when fetch throws", async () => {
  const check = await checkGoPlus(ADDR, throwingFetch(new Error("network down")));
  assert.equal(check.status, "unknown");
});

test("checkGoPlus is unknown when fetch aborts (timeout)", async () => {
  const check = await checkGoPlus(ADDR, throwingFetch(new DOMException("aborted", "AbortError")));
  assert.equal(check.status, "unknown");
});

test("checkGoPlus is unknown when the body is not valid JSON", async () => {
  const { fn } = captureFetch({}, { raw: "not json at all" });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "unknown");
});

test("checkGoPlus does not call the network for an invalid address", async () => {
  const { calls, fn } = captureFetch({ code: 1, message: "ok", result: cleanResult() });
  const check = await checkGoPlus("not-an-address", fn);
  assert.equal(check.status, "unknown");
  assert.equal(calls.length, 0);
});

test("checkGoPlus is unknown for a too-short hex address", async () => {
  const { calls, fn } = captureFetch({ code: 1, message: "ok", result: cleanResult() });
  const check = await checkGoPlus("0x1234", fn);
  assert.equal(check.status, "unknown");
  assert.equal(calls.length, 0);
});

test("checkGoPlus accepts a mixed-case checksummed address", async () => {
  const { fn } = captureFetch({ code: 1, message: "ok", result: cleanResult() });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "pass");
});

test("checkGoPlus ignores unknown extra fields", async () => {
  const result = { ...cleanResult(), foo: "bar", extra: { nested: true }, arr: [1, 2, 3], code: "1" };
  const { fn } = captureFetch({ code: 1, message: "ok", result });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "pass");
});

test("checkGoPlus treats a numeric 1 like the string '1'", async () => {
  const result: Record<string, unknown> = { ...cleanResult() };
  result.sanctioned = 1;
  const { fn } = captureFetch({ code: 1, message: "ok", result });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "fail");
});

test("blacklist_doubt alone is a warn, not a block", async () => {
  const result = cleanResult();
  result.blacklist_doubt = "1";
  const { fn } = captureFetch({ code: 1, message: "ok", result });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "warn");
  assert.ok(check.detail.includes("blacklist_doubt"));
});

test("blacklist_doubt with a hard flag is a fail that names both", async () => {
  const result = cleanResult();
  result.blacklist_doubt = "1";
  result.stealing_attack = "1";
  const { fn } = captureFetch({ code: 1, message: "ok", result });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "fail");
  assert.equal(check.detail, "Security flags in GoPlus: stealing_attack, blacklist_doubt.");
});

test("checkGoPlus treats empty-string flag values as clean", async () => {
  const result = cleanResult();
  result.mixer = "";
  const { fn } = captureFetch({ code: 1, message: "ok", result });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "pass");
});

test("checkGoPlus passes when flag fields are absent entirely", async () => {
  const { fn } = captureFetch({ code: 1, message: "ok", result: { data_source: "SlowMist" } });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "pass");
  assert.equal(check.detail, "No security flags in GoPlus (sources: SlowMist).");
});

test("checkGoPlus omits the source list when data_source is absent", async () => {
  const result = cleanResult();
  delete result.data_source;
  const { fn } = captureFetch({ code: 1, message: "ok", result });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "pass");
  assert.equal(check.detail, "No security flags in GoPlus.");
});

test("checkGoPlus omits the source list when data_source is empty", async () => {
  const result = cleanResult();
  result.data_source = "   ";
  const { fn } = captureFetch({ code: 1, message: "ok", result });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "pass");
  assert.equal(check.detail, "No security flags in GoPlus.");
});

test("checkGoPlus hits the GoPlus URL with chain_id=8453 and a timeout signal", async () => {
  const { calls, fn } = captureFetch({ code: 1, message: "ok", result: cleanResult() });
  await checkGoPlus(ADDR, fn);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    `https://api.gopluslabs.io/api/v1/address_security/${ADDR}?chain_id=8453`,
  );
  const signal = calls[0]!.init?.signal;
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
});

test("verdict is ok with no checks", () => {
  assert.deepEqual(verdict([]), { verdict: "ok", reasons: [] });
});

test("verdict is ok when every check passes", () => {
  const checks = [
    { id: "a", status: "pass" as const, detail: "ok one" },
    { id: "b", status: "pass" as const, detail: "ok two" },
  ];
  assert.deepEqual(verdict(checks), { verdict: "ok", reasons: [] });
});

test("verdict blocks on a single fail", () => {
  const checks = [
    { id: "a", status: "pass" as const, detail: "fine" },
    { id: "b", status: "fail" as const, detail: "bad" },
  ];
  assert.deepEqual(verdict(checks), { verdict: "block", reasons: ["bad"] });
});

test("verdict is caution on a warn", () => {
  const checks = [{ id: "a", status: "warn" as const, detail: "heads up" }];
  assert.deepEqual(verdict(checks), { verdict: "caution", reasons: ["heads up"] });
});

test("verdict is caution on an unknown", () => {
  const checks = [{ id: "a", status: "unknown" as const, detail: "no data" }];
  assert.deepEqual(verdict(checks), { verdict: "caution", reasons: ["no data"] });
});

test("verdict blocks and lists all non-pass reasons in order", () => {
  const checks = [
    { id: "a", status: "pass" as const, detail: "fine" },
    { id: "b", status: "warn" as const, detail: "warn one" },
    { id: "c", status: "unknown" as const, detail: "unknown one" },
    { id: "d", status: "fail" as const, detail: "fail one" },
  ];
  assert.deepEqual(verdict(checks), {
    verdict: "block",
    reasons: ["warn one", "unknown one", "fail one"],
  });
});

test("verdict is caution and preserves reason order for warn+unknown", () => {
  const checks = [
    { id: "a", status: "unknown" as const, detail: "first" },
    { id: "b", status: "warn" as const, detail: "second" },
  ];
  assert.deepEqual(verdict(checks), { verdict: "caution", reasons: ["first", "second"] });
});

test("checkGoPlus fails a deployer of malicious contracts (count, not flag)", async () => {
  const result = { ...cleanResult(), number_of_malicious_contracts_created: "7" };
  const { fn } = captureFetch({ code: 1, message: "ok", result });
  const check = await checkGoPlus(ADDR, fn);
  assert.equal(check.status, "fail");
  assert.match(check.detail, /number_of_malicious_contracts_created=7/);
});
