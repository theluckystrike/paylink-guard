import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildPaymentLink, fromAtomic, parsePaymentLink, resolveAmount, toAtomic } from "../src/links.js";
import { BASE_USDC, PayLinkError, SOLANA_USDC_MINT } from "../src/types.js";

const USDC_CHECKSUM = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const RECIPIENT_CHECKSUM = "0x1111111111111111111111111111111111111111";
const SOL_RECIPIENT = "11111111111111111111111111111111";
const SOL_REFERENCE = "2kJFA4qYqBdQscBGmxxQzUUuXnB9V9smG8aHrZq1vUge";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof PayLinkError, "expected a PayLinkError");
    return (err as PayLinkError).code;
  }
  assert.fail("expected fn to throw");
}

describe("toAtomic", () => {
  test("converts whole units to atomic", () => {
    assert.equal(toAtomic("1", 6), "1000000");
    assert.equal(toAtomic("1.25", 6), "1250000");
    assert.equal(toAtomic("0", 6), "0");
    assert.equal(toAtomic("0.001", 6), "1000");
    assert.equal(toAtomic("1.5", 18), "1500000000000000000");
  });

  test("pads fraction to asset decimals", () => {
    assert.equal(toAtomic("2", 9), "2000000000");
    assert.equal(toAtomic("0.000000001", 9), "1");
  });

  test("rejects too many decimal places", () => {
    assert.equal(codeOf(() => toAtomic("1.2345678", 6)), "invalid_amount");
    assert.equal(codeOf(() => toAtomic("1.1", 0)), "invalid_amount");
  });

  test("rejects negative, empty, and scientific notation", () => {
    assert.equal(codeOf(() => toAtomic("-1", 6)), "invalid_amount");
    assert.equal(codeOf(() => toAtomic("", 6)), "invalid_amount");
    assert.equal(codeOf(() => toAtomic("1e3", 6)), "invalid_amount");
    assert.equal(codeOf(() => toAtomic("01", 6)), "invalid_amount");
  });

  test("rejects invalid decimals", () => {
    assert.equal(codeOf(() => toAtomic("1", -1)), "invalid_amount");
    assert.equal(codeOf(() => toAtomic("1", 1.5)), "invalid_amount");
    assert.equal(codeOf(() => toAtomic("1", 256)), "invalid_amount");
  });
});

describe("fromAtomic", () => {
  test("converts atomic to whole units", () => {
    assert.equal(fromAtomic("1250000", 6), "1.25");
    assert.equal(fromAtomic("1000", 6), "0.001");
    assert.equal(fromAtomic("0", 6), "0");
    assert.equal(fromAtomic("1000000", 6), "1");
  });

  test("handles 18 decimals and zero decimals", () => {
    assert.equal(fromAtomic("1000000000000000000", 18), "1");
    assert.equal(fromAtomic("1", 18), "0.000000000000000001");
    assert.equal(fromAtomic("123", 0), "123");
  });

  test("rejects non-integer atomic", () => {
    assert.equal(codeOf(() => fromAtomic("-1", 6)), "invalid_amount");
    assert.equal(codeOf(() => fromAtomic("1.5", 6)), "invalid_amount");
    assert.equal(codeOf(() => fromAtomic("01", 6)), "invalid_amount");
  });
});

describe("parsePaymentLink: EIP-681 ETH", () => {
  test("parses a native ETH link with label and message", () => {
    const req = parsePaymentLink(`ethereum:${RECIPIENT}@8453?value=1000000000000000000&label=Test%20label&message=hello+world`);
    assert.equal(req.standard, "eip681");
    assert.equal(req.chain, "base");
    assert.equal(req.caip2, "eip155:8453");
    assert.equal(req.asset.symbol, "ETH");
    assert.equal(req.recipient, RECIPIENT_CHECKSUM);
    assert.equal(req.amount, "1");
    assert.equal(req.atomicAmount, "1000000000000000000");
    assert.equal(req.label, "Test label");
    assert.equal(req.message, "hello+world");
  });

  test("normalizes a lowercase address to EIP-55 checksum", () => {
    const req = parsePaymentLink("ethereum:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@8453?value=1");
    assert.equal(req.recipient, USDC_CHECKSUM);
  });

  test("resolves scientific notation to an exact integer", () => {
    assert.equal(parsePaymentLink(`ethereum:${RECIPIENT}@8453?value=1e15`).atomicAmount, "1000000000000000");
    assert.equal(parsePaymentLink(`ethereum:${RECIPIENT}@8453?value=1.5e15`).atomicAmount, "1500000000000000");
    assert.equal(parsePaymentLink(`ethereum:${RECIPIENT}@8453?value=1.25e18`).atomicAmount, "1250000000000000000");
  });

  test("accepts an uppercase scheme", () => {
    const req = parsePaymentLink(`ETHEREUM:${RECIPIENT}@8453?value=5`);
    assert.equal(req.chain, "base");
    assert.equal(req.atomicAmount, "5");
  });

  test("rejects a wrong-checksum mixed-case address (likely typo or tampering)", () => {
    assert.equal(codeOf(() => parsePaymentLink("ethereum:0x833589Fcd6edb6e08f4c7c32d4f71b54bda02913@8453?value=1")), "bad_checksum");
  });

  test("rejects a one-character case flip in a checksummed USDC recipient", () => {
    const flipped = RECIPIENT_CHECKSUM.replace(/[a-f]/, (c) => c.toUpperCase());
    if (flipped !== RECIPIENT_CHECKSUM) {
      assert.equal(codeOf(() => parsePaymentLink(`ethereum:${USDC_CHECKSUM}@8453/transfer?address=${flipped}&uint256=1`)), "bad_checksum");
    }
  });

  test("accepts all-uppercase hex (no checksum) and normalizes it", () => {
    const req = parsePaymentLink("ethereum:0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913@8453?value=1");
    assert.equal(req.recipient, USDC_CHECKSUM);
  });

  test("accepts pay- with a USDC transfer function (EIP-681 grammar)", () => {
    const req = parsePaymentLink(`ethereum:pay-${USDC_CHECKSUM}@8453/transfer?address=${RECIPIENT}&uint256=2500000`);
    assert.equal(req.asset.symbol, "USDC");
    assert.equal(req.amount, "2.5");
  });

  test("accepts the pay- prefix", () => {
    const req = parsePaymentLink(`ethereum:pay-${RECIPIENT}@8453?value=5`);
    assert.equal(req.recipient, RECIPIENT_CHECKSUM);
    assert.equal(req.atomicAmount, "5");
  });

  test("trims surrounding whitespace", () => {
    const req = parsePaymentLink(`  ethereum:${RECIPIENT}@8453?value=7  `);
    assert.equal(req.atomicAmount, "7");
  });

  test("missing chain means mainnet and is rejected", () => {
    assert.equal(codeOf(() => parsePaymentLink(`ethereum:${RECIPIENT}?value=1`)), "unsupported_chain");
    assert.equal(codeOf(() => parsePaymentLink(`ethereum:${RECIPIENT}@1?value=1`)), "unsupported_chain");
  });

  test("allows a link with no value", () => {
    const req = parsePaymentLink(`ethereum:${RECIPIENT}@8453`);
    assert.equal(req.amount, null);
    assert.equal(req.atomicAmount, null);
  });

  test("rejects a non-integer scientific value", () => {
    assert.equal(codeOf(() => parsePaymentLink(`ethereum:${RECIPIENT}@8453?value=1.5e0`)), "invalid_amount");
    assert.equal(codeOf(() => parsePaymentLink(`ethereum:${RECIPIENT}@8453?value=1e-1`)), "invalid_amount");
  });

  test("rejects negative and empty values", () => {
    assert.equal(codeOf(() => parsePaymentLink(`ethereum:${RECIPIENT}@8453?value=-5`)), "invalid_amount");
    assert.equal(codeOf(() => parsePaymentLink(`ethereum:${RECIPIENT}@8453?value=`)), "invalid_amount");
  });

  test("rejects duplicate value params", () => {
    assert.equal(codeOf(() => parsePaymentLink(`ethereum:${RECIPIENT}@8453?value=1&value=2`)), "unsupported");
  });

  test("handles huge numbers exactly", () => {
    const req = parsePaymentLink(`ethereum:${RECIPIENT}@8453?value=1e60`);
    assert.equal(req.atomicAmount, "1" + "0".repeat(60));
  });
});

describe("parsePaymentLink: EIP-681 USDC", () => {
  test("parses a Base USDC transfer link", () => {
    const req = parsePaymentLink(`ethereum:${BASE_USDC}@8453/transfer?address=${RECIPIENT}&uint256=1250000`);
    assert.equal(req.asset.symbol, "USDC");
    assert.equal(req.asset.address, BASE_USDC);
    assert.equal(req.recipient, RECIPIENT_CHECKSUM);
    assert.equal(req.amount, "1.25");
    assert.equal(req.atomicAmount, "1250000");
  });

  test("matches the token contract case-insensitively", () => {
    const lower = BASE_USDC.toLowerCase();
    const req = parsePaymentLink(`ethereum:${lower}@8453/transfer?address=${RECIPIENT}&uint256=1`);
    assert.equal(req.asset.symbol, "USDC");
  });

  test("rejects a wrong token contract", () => {
    assert.equal(codeOf(() => parsePaymentLink(`ethereum:${RECIPIENT}@8453/transfer?address=${RECIPIENT}&uint256=1`)), "unsupported_token");
  });

  test("rejects missing address or uint256", () => {
    assert.equal(codeOf(() => parsePaymentLink(`ethereum:${BASE_USDC}@8453/transfer?uint256=1`)), "unsupported");
    assert.equal(codeOf(() => parsePaymentLink(`ethereum:${BASE_USDC}@8453/transfer?address=${RECIPIENT}`)), "unsupported");
  });

  test("supports scientific notation in uint256", () => {
    const req = parsePaymentLink(`ethereum:${BASE_USDC}@8453/transfer?address=${RECIPIENT}&uint256=1.25e6`);
    assert.equal(req.atomicAmount, "1250000");
  });

  test("rejects unknown function names", () => {
    assert.equal(codeOf(() => parsePaymentLink(`ethereum:${BASE_USDC}@8453/approve?address=${RECIPIENT}&uint256=1`)), "unsupported");
  });
});

describe("parsePaymentLink: Solana Pay", () => {
  test("parses a SOL transfer", () => {
    const req = parsePaymentLink(`solana:${SOL_RECIPIENT}?amount=1.5`);
    assert.equal(req.standard, "solana-pay");
    assert.equal(req.chain, "solana");
    assert.equal(req.caip2, "solana:mainnet");
    assert.equal(req.asset.symbol, "SOL");
    assert.equal(req.amount, "1.5");
    assert.equal(req.atomicAmount, "1500000000");
  });

  test("parses a USDC transfer with the spl-token mint", () => {
    const req = parsePaymentLink(`solana:${SOL_RECIPIENT}?amount=2&spl-token=${SOLANA_USDC_MINT}`);
    assert.equal(req.asset.symbol, "USDC");
    assert.equal(req.asset.decimals, 6);
    assert.equal(req.atomicAmount, "2000000");
  });

  test("rejects an unsupported mint", () => {
    assert.equal(codeOf(() => parsePaymentLink(`solana:${SOL_RECIPIENT}?amount=1&spl-token=deadbeef`)), "unsupported_token");
  });

  test("parses references, label, message, and memo", () => {
    const req = parsePaymentLink(
      `solana:${SOL_RECIPIENT}?amount=1&reference=${SOL_REFERENCE}&label=My%20Store&message=Order+42&memo=%E2%9C%93`,
    );
    assert.deepEqual(req.references, [SOL_REFERENCE]);
    assert.equal(req.label, "My Store");
    assert.equal(req.message, "Order 42");
    assert.equal(req.memo, "\u2713");
  });

  test("allows a link with no amount", () => {
    const req = parsePaymentLink(`solana:${SOL_RECIPIENT}?label=donate`);
    assert.equal(req.amount, null);
    assert.equal(req.atomicAmount, null);
  });

  test("rejects an interactive transaction request", () => {
    assert.equal(codeOf(() => parsePaymentLink("solana:https://example.com/pay")), "unsupported");
  });

  test("rejects too many decimal places", () => {
    assert.equal(codeOf(() => parsePaymentLink(`solana:${SOL_RECIPIENT}?amount=1.1234567890`)), "invalid_amount");
  });

  test("rejects scientific notation in the amount", () => {
    assert.equal(codeOf(() => parsePaymentLink(`solana:${SOL_RECIPIENT}?amount=1e9`)), "invalid_amount");
  });

  test("rejects an invalid recipient and reference", () => {
    assert.equal(codeOf(() => parsePaymentLink("solana:not-a-key?amount=1")), "unsupported");
    assert.equal(codeOf(() => parsePaymentLink(`solana:${SOL_RECIPIENT}?reference=0`)), "unsupported");
  });
});

describe("parsePaymentLink: hostile input", () => {
  test("rejects empty and non-string input", () => {
    assert.equal(codeOf(() => parsePaymentLink("")), "unsupported");
    assert.equal(codeOf(() => parsePaymentLink("   ")), "unsupported");
    assert.equal(codeOf(() => parsePaymentLink(undefined as unknown as string)), "unsupported");
  });

  test("rejects unknown schemes", () => {
    assert.equal(codeOf(() => parsePaymentLink("bitcoin:abc")), "unsupported");
    assert.equal(codeOf(() => parsePaymentLink("https://example.com")), "unsupported");
  });

  test("rejects an invalid EVM address", () => {
    assert.equal(codeOf(() => parsePaymentLink("ethereum:0x1234@8453?value=1")), "unsupported");
    assert.equal(codeOf(() => parsePaymentLink("ethereum:0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ@8453?value=1")), "unsupported");
  });

  test("rejects duplicate amount params", () => {
    assert.equal(codeOf(() => parsePaymentLink(`solana:${SOL_RECIPIENT}?amount=1&amount=2`)), "unsupported");
  });
});

describe("buildPaymentLink", () => {
  test("round-trips ETH", () => {
    const link = buildPaymentLink({ chain: "base", asset: "ETH", recipient: RECIPIENT, amount: "1.25" });
    const req = parsePaymentLink(link);
    assert.equal(req.asset.symbol, "ETH");
    assert.equal(req.recipient, RECIPIENT_CHECKSUM);
    assert.equal(req.atomicAmount, "1250000000000000000");
  });

  test("round-trips Base USDC", () => {
    const link = buildPaymentLink({ chain: "base", asset: "USDC", recipient: RECIPIENT, amount: "12.5" });
    const req = parsePaymentLink(link);
    assert.equal(req.asset.symbol, "USDC");
    assert.equal(req.recipient, RECIPIENT_CHECKSUM);
    assert.equal(req.atomicAmount, "12500000");
  });

  test("round-trips SOL", () => {
    const link = buildPaymentLink({ chain: "solana", asset: "SOL", recipient: SOL_RECIPIENT, amount: "0.5" });
    const req = parsePaymentLink(link);
    assert.equal(req.asset.symbol, "SOL");
    assert.equal(req.recipient, SOL_RECIPIENT);
    assert.equal(req.atomicAmount, "500000000");
  });

  test("round-trips Solana USDC with references", () => {
    const link = buildPaymentLink({
      chain: "solana", asset: "USDC", recipient: SOL_RECIPIENT, amount: "1",
      reference: [SOL_REFERENCE], label: "a b", memo: "hi",
    });
    const req = parsePaymentLink(link);
    assert.equal(req.asset.symbol, "USDC");
    assert.deepEqual(req.references, [SOL_REFERENCE]);
    assert.equal(req.label, "a b");
    assert.equal(req.memo, "hi");
    assert.equal(req.atomicAmount, "1000000");
  });

  test("rejects unsupported chain/asset combinations", () => {
    assert.equal(codeOf(() => buildPaymentLink({ chain: "base", asset: "SOL", recipient: RECIPIENT, amount: "1" })), "unsupported");
    assert.equal(codeOf(() => buildPaymentLink({ chain: "solana", asset: "ETH", recipient: SOL_RECIPIENT, amount: "1" })), "unsupported");
  });

  test("rejects an invalid recipient and amount", () => {
    assert.equal(codeOf(() => buildPaymentLink({ chain: "base", asset: "ETH", recipient: "0x1234", amount: "1" })), "unsupported");
    assert.equal(codeOf(() => buildPaymentLink({ chain: "base", asset: "ETH", recipient: RECIPIENT, amount: "-1" })), "invalid_amount");
  });
});

describe("resolveAmount", () => {
  test("returns the parsed amount when the link has one", () => {
    const req = parsePaymentLink(`ethereum:${RECIPIENT}@8453?value=1000`);
    assert.deepEqual(resolveAmount(req), { amount: "0.000000000000001", atomic: "1000" });
    assert.deepEqual(resolveAmount(req, "0.000000000000001"), { amount: "0.000000000000001", atomic: "1000" });
  });

  test("rejects an override that conflicts with the link amount", () => {
    const req = parsePaymentLink(`ethereum:${RECIPIENT}@8453?value=1000`);
    assert.equal(codeOf(() => resolveAmount(req, "5")), "amount_conflict");
  });

  test("rejects duplicate references and a reference equal to the recipient", () => {
    assert.equal(codeOf(() => parsePaymentLink(`solana:${SOL_RECIPIENT}?reference=${SOL_REFERENCE}&reference=${SOL_REFERENCE}`)), "unsupported");
    assert.equal(codeOf(() => parsePaymentLink(`solana:${SOL_RECIPIENT}?reference=${SOL_RECIPIENT}`)), "unsupported");
  });

  test("buildPaymentLink rejects Solana-only fields on Base", () => {
    assert.throws(() => buildPaymentLink({ chain: "base", asset: "USDC", recipient: RECIPIENT, amount: "1", memo: "x" }), PayLinkError);
  });

  test("derives atomic from an override when the link has no amount", () => {
    const req = parsePaymentLink(`solana:${SOL_RECIPIENT}`);
    assert.deepEqual(resolveAmount(req, "0.25"), { amount: "0.25", atomic: "250000000" });
  });

  test("throws when no amount and no override", () => {
    const req = parsePaymentLink(`solana:${SOL_RECIPIENT}`);
    assert.equal(codeOf(() => resolveAmount(req)), "missing_amount");
  });

  test("rejects an invalid override", () => {
    const req = parsePaymentLink(`solana:${SOL_RECIPIENT}`);
    assert.equal(codeOf(() => resolveAmount(req, "1e3")), "invalid_amount");
  });
});

describe("review fixes (R1, W5)", () => {
  test("EIP-681 accepts 1e+3 with an explicit plus exponent", () => {
    assert.equal(parsePaymentLink(`ethereum:${RECIPIENT}@8453?value=1e+3`).atomicAmount, "1000");
  });
  test("EIP-681 refuses an amount above uint256 with a clear code", () => {
    assert.equal(codeOf(() => parsePaymentLink(`ethereum:${RECIPIENT}@8453?value=1e78`)), "invalid_amount");
    assert.equal(codeOf(() => parsePaymentLink(`ethereum:${RECIPIENT}@8453?value=1e101`)), "invalid_amount");
  });
  test("Solana Pay keeps form decoding (+ is a space), as the reference parser does", () => {
    assert.equal(parsePaymentLink(`solana:${SOL_RECIPIENT}?amount=1&message=Order+42`).message, "Order 42");
  });
  test("unknown parameters are refused on all three link forms", () => {
    assert.equal(codeOf(() => parsePaymentLink(`ethereum:${RECIPIENT}@8453?value=1&foo=1`)), "unknown_parameter");
    assert.equal(codeOf(() => parsePaymentLink(`ethereum:${USDC_CHECKSUM}@8453/transfer?address=${RECIPIENT}&uint256=1&value=1`)), "unknown_parameter");
    assert.equal(codeOf(() => parsePaymentLink(`solana:${SOL_RECIPIENT}?amount=1&Spl-Token=${SOLANA_USDC_MINT}`)), "unknown_parameter");
  });
  test("a memo above 500 bytes is refused at parse time", () => {
    assert.equal(codeOf(() => parsePaymentLink(`solana:${SOL_RECIPIENT}?amount=1&memo=${"a".repeat(501)}`)), "unsupported");
  });
  test("create refuses zero amounts and unpayable Base recipients", () => {
    assert.equal(codeOf(() => buildPaymentLink({ chain: "base", asset: "USDC", recipient: RECIPIENT, amount: "0" })), "invalid_amount");
    assert.equal(codeOf(() => buildPaymentLink({ chain: "base", asset: "USDC", recipient: "0x000000000000000000000000000000000000dEaD", amount: "1" })), "unsupported");
  });
});
