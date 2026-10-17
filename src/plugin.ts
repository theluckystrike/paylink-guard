import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

import { buildBaseProposal } from "./evm.js";
import { gate, runChecks, summary } from "./gate.js";
import { buildPaymentLink, parsePaymentLink, resolveAmount } from "./links.js";
import { evmOutputSchema, solanaOutputSchema } from "./paybox.js";
import { verdict } from "./risk.js";
import { buildSolanaProposal } from "./solana.js";
import { verifyPayment } from "./verify.js";
import { PayLinkError, type Check, type PaymentRequest } from "./types.js";

const PROTOCOL_VERSION = "2026-07-28";
const NAME = "paylink-guard";
const VERSION = "1.0.0";

const decimal = z.string().trim().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/, "Use a plain decimal string such as \"12.50\".").max(80);
const link = z.string().trim().min(8).max(4096);

const checkSchema = z.object({ id: z.string(), status: z.enum(["pass", "warn", "fail", "unknown"]), detail: z.string() }).strict();
const requestSchema = z.object({
  standard: z.enum(["eip681", "solana-pay"]),
  chain: z.enum(["base", "solana"]),
  asset: z.enum(["ETH", "USDC", "SOL"]),
  recipient: z.string(),
  amount: z.string().nullable(),
  label: z.string().optional(),
  message: z.string().optional(),
  memo: z.string().optional(),
  references: z.array(z.string()),
}).strict();

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function failure(err: unknown) {
  if (err instanceof PayLinkError) return errorResult(`${err.message} (code: ${err.code})`);
  const message = err instanceof Error ? err.message : String(err);
  return errorResult(`PayLink Guard could not prepare this payment: ${message}`);
}

function publicRequest(req: PaymentRequest) {
  return {
    standard: req.standard,
    chain: req.chain,
    asset: req.asset.symbol,
    recipient: req.recipient,
    amount: req.amount,
    ...(req.label === undefined ? {} : { label: req.label }),
    ...(req.message === undefined ? {} : { message: req.message }),
    ...(req.memo === undefined ? {} : { memo: req.memo }),
    references: req.references,
  };
}

const payInput = {
  link: link.describe("The payment link from the merchant, exactly as received."),
  asset: z.enum(["USDC", "ETH", "SOL"]).describe("The asset the user agreed to pay. The tool refuses a link in any other asset."),
  max_amount: decimal.describe("The most the user agreed to pay, in whole units of that asset (for example \"25\" for 25 USDC). The tool refuses a link that asks for more."),
  amount: decimal.optional().describe("Only for links without an amount: the amount to pay, in whole units."),
  expected_recipient: z.string().trim().min(32).max(64).optional().describe("Optional: the address the user expects to pay. The tool refuses a link that pays anyone else."),
  confirm_code: z.string().regex(/^[0-9a-f]{8}$/).optional().describe("Only after the user has seen and accepted the caution reasons: the code from the needs_confirmation error."),
};

const annotationsPay = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };

function registerCreateLink(server: McpServer) {
  server.registerTool("create_payment_link", {
    title: "Create a payment link",
    description: "For merchants: make a standard payment link (EIP-681 on Base, Solana Pay on Solana) that any wallet or PayBox agent can pay. Supported: USDC or ETH on Base, USDC or SOL on Solana. No network access.",
    inputSchema: z.object({
      chain: z.enum(["base", "solana"]),
      asset: z.enum(["USDC", "ETH", "SOL"]),
      recipient: z.string().trim().min(32).max(64).describe("The merchant's wallet address on that chain."),
      amount: decimal.describe("Amount in whole units, for example \"19.99\"."),
      label: z.string().max(100).optional().describe("Merchant name shown to the payer."),
      message: z.string().max(200).optional().describe("What the payment is for, for example an invoice number."),
      memo: z.string().max(100).optional().describe("Solana only: on-chain memo."),
      reference: z.array(z.string().max(64)).max(4).optional().describe("Solana only: reference public keys used to find the payment on chain."),
    }).strict(),
    outputSchema: z.object({ link: z.string(), chain: z.enum(["base", "solana"]), asset: z.enum(["USDC", "ETH", "SOL"]), recipient: z.string(), amount: z.string() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    try {
      const out = buildPaymentLink(input);
      const req = parsePaymentLink(out);
      const amount = req.amount ?? input.amount;
      return {
        content: [{ type: "text" as const, text: `Payment link for ${amount} ${req.asset.symbol} on ${req.chain === "base" ? "Base" : "Solana"}:\n${out}` }],
        structuredContent: { link: out, chain: req.chain, asset: req.asset.symbol, recipient: req.recipient, amount },
      };
    } catch (err) {
      return failure(err);
    }
  });
}

function registerCheckLink(server: McpServer) {
  server.registerTool("check_payment_link", {
    title: "Check a payment link",
    description: "Read a Base (EIP-681) or Solana Pay payment link and check the recipient before paying: wallet or contract, account history, token-account mistakes, and GoPlus security flags on Base. Returns ok, caution or block with reasons. Does not create a payment.",
    inputSchema: z.object({ link: link.describe("The payment link from the merchant.") }).strict(),
    outputSchema: z.object({
      request: requestSchema,
      verdict: z.enum(["ok", "caution", "block"]),
      reasons: z.array(z.string()),
      checks: z.array(checkSchema),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ link: uri }) => {
    try {
      const req = parsePaymentLink(uri);
      const checks = await runChecks(req);
      const v = verdict(checks);
      const amount = req.amount === null ? "an amount you choose" : `${req.amount} ${req.asset.symbol}`;
      const text = [
        `${v.verdict.toUpperCase()}: ${amount} on ${req.chain === "base" ? "Base" : "Solana"} to ${req.recipient}.`,
        ...checks.map((c) => `- ${c.status.toUpperCase()} ${c.id}: ${c.detail}`),
      ].join("\n");
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { request: publicRequest(req), verdict: v.verdict, reasons: v.reasons, checks },
      };
    } catch (err) {
      return failure(err);
    }
  });
}

function registerPayTools(server: McpServer) {
  server.registerTool("pay_base_link", {
    title: "Pay a Base payment link",
    description: "Pay an EIP-681 link for USDC or ETH on Base. Checks the recipient, refuses amounts above max_amount, then returns an unsigned PayBox transaction proposal. PayBox simulates it and the user approves it; this tool never signs.",
    inputSchema: z.object({
      ...payInput,
      sender: z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/, "Use a 0x Base address.").optional().describe("Optional: public address of the user's EVM wallet selected in PayBox. When given, the tool checks the wallet has enough USDC or ETH, and ETH for gas."),
    }).strict(),
    outputSchema: evmOutputSchema,
    annotations: annotationsPay,
  }, async ({ sender, ...args }) => {
    try {
      const g = await gate(args, "base", sender);
      const proposal = buildBaseProposal(g.req, g.atomic);
      return { ...proposal, content: [{ type: "text" as const, text: summary(g.req, g.amount, g.checks) }] };
    } catch (err) {
      return failure(err);
    }
  });

  server.registerTool("pay_solana_link", {
    title: "Pay a Solana Pay link",
    description: "Pay a Solana Pay transfer link for USDC or SOL. Checks the recipient, refuses amounts above max_amount, keeps the link's reference keys and memo so the merchant can find the payment, then returns an unsigned PayBox transaction proposal. Needs the payer's public wallet address as sender; never a private key.",
    inputSchema: z.object({
      ...payInput,
      sender: z.string().trim().min(32).max(44).optional().describe("Required for Solana: public address of the user's Solana wallet selected in PayBox. Never a private key."),
    }).strict(),
    outputSchema: solanaOutputSchema,
    annotations: annotationsPay,
  }, async ({ sender, ...args }) => {
    try {
      const g = await gate(args, "solana", sender);
      const proposal = buildSolanaProposal(g.req, g.atomic, sender!);
      return { ...proposal, content: [{ type: "text" as const, text: summary(g.req, g.amount, g.checks) }] };
    } catch (err) {
      return failure(err);
    }
  });
}

function registerVerify(server: McpServer) {
  server.registerTool("verify_payment", {
    title: "Verify a payment",
    description: "For merchants: confirm on chain that a payment link was paid in full. Solana: uses the link's reference key, or a transaction signature. Base: needs the transaction hash. Returns paid, mismatch, pending, failed or not_found. Read only.",
    inputSchema: z.object({
      link: link.describe("The payment link that was paid."),
      signature: z.string().trim().min(64).max(100).optional().describe("Solana only: the transaction signature, when the link has no reference key."),
      tx_hash: z.string().trim().regex(/^0x[0-9a-fA-F]{64}$/).optional().describe("Base only: the transaction hash of the payment."),
      amount: decimal.optional().describe("Only for links without an amount: the amount that should have been paid."),
      min_block: z.number().int().positive().optional().describe("Base only: refuse transactions mined before this block, for example the block when the invoice was created."),
    }).strict(),
    outputSchema: z.object({
      status: z.enum(["paid", "mismatch", "pending", "failed", "not_found"]),
      verified: z.boolean(),
      transaction: z.string().nullable(),
      detail: z.string(),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ link: uri, signature, tx_hash, amount, min_block }) => {
    try {
      const req = parsePaymentLink(uri);
      const resolved = resolveAmount(req, amount);
      const r = await verifyPayment({ ...req, amount: resolved.amount, atomicAmount: resolved.atomic }, { signature, txHash: tx_hash, minBlock: min_block });
      return { content: [{ type: "text" as const, text: r.detail }], structuredContent: { ...r } };
    } catch (err) {
      return failure(err);
    }
  });
}

function createServer() {
  const server = new McpServer({ name: NAME, version: VERSION }, { supportedProtocolVersions: [PROTOCOL_VERSION] });
  registerCreateLink(server);
  registerCheckLink(server);
  registerPayTools(server);
  registerVerify(server);
  return server;
}

serveStdio(createServer, { legacy: "reject" });
