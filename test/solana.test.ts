import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { buildSolanaProposal, checkSolanaRecipient } from "../src/solana.js";
import { PayLinkError, SOLANA_USDC_MINT, HOSTS, type PaymentRequest } from "../src/types.js";

const ZERO_BLOCKHASH = "11111111111111111111111111111111";
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const U64_MAX = 2n ** 64n;

function makeRequest(asset: "SOL" | "USDC", recipient: string, overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    standard: "solana-pay",
    chain: "solana",
    caip2: "solana:mainnet",
    asset:
      asset === "SOL"
        ? { symbol: "SOL", decimals: 9 }
        : { symbol: "USDC", decimals: 6, address: SOLANA_USDC_MINT },
    recipient,
    amount: null,
    atomicAmount: null,
    references: [],
    raw: `solana:${recipient}`,
    ...overrides,
  };
}

function decode(bytes: string): Transaction {
  return Transaction.from(Buffer.from(bytes, "base64"));
}

function proposalBase64(result: {
  structuredContent: { [k: string]: { transaction: { transactionBase64: string } } };
}): string {
  return result.structuredContent["io.paybox/transactionProposal"]!.transaction.transactionBase64;
}

type RpcValue = Record<string, unknown>;
const systemAccount = (): RpcValue => ({
  lamports: 1_000_000,
  owner: SystemProgram.programId.toBase58(),
  executable: false,
  rentEpoch: 0,
});
const tokenAccount = (owner = TOKEN_PROGRAM_ID): RpcValue => ({
  lamports: 2_039_280,
  owner: owner.toBase58(),
  executable: false,
  rentEpoch: 0,
});
const programAccount = (): RpcValue => ({
  lamports: 1_000_000,
  owner: "BPFLoaderUpgradeab1e11111111111111111111111",
  executable: true,
  rentEpoch: 0,
});

function fetchWith(handler: (pubkey: string) => RpcValue | null): typeof fetch {
  const fn = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const value = handler(body.params[0]);
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 1 }, value } }),
    } as unknown as Response;
  };
  return fn as typeof fetch;
}

// ---------------------------------------------------------------------------
// buildSolanaProposal — SOL
// ---------------------------------------------------------------------------

test("SOL transfer: correct program, fee payer and exactly one signer", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const result = buildSolanaProposal(makeRequest("SOL", recipient.toBase58()), "5000000", sender.toBase58());

  const base64 = proposalBase64(result);
  const tx = decode(base64);

  assert.equal(tx.instructions.length, 1);
  assert.equal(tx.instructions[0]!.programId.toBase58(), SystemProgram.programId.toBase58());
  assert.ok(tx.feePayer!.equals(sender));
  assert.equal(tx.recentBlockhash, ZERO_BLOCKHASH);
  assert.equal(tx.signatures.length, 1);
  assert.ok(tx.signatures[0]!.publicKey.equals(sender));
});

test("SOL transfer: encodes the exact lamports amount", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const lamports = "12345678901234";
  const result = buildSolanaProposal(makeRequest("SOL", recipient.toBase58()), lamports, sender.toBase58());
  const base64 = proposalBase64(result);
  const tx = decode(base64);

  const data = tx.instructions[0]!.data;
  assert.equal(data.readUInt32LE(0), 2);
  assert.equal(data.readBigUInt64LE(4), BigInt(lamports));
});

test("SOL transfer: appends references as non-signer read-only keys", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const refA = Keypair.generate().publicKey;
  const refB = Keypair.generate().publicKey;
  const result = buildSolanaProposal(
    makeRequest("SOL", recipient.toBase58(), { references: [refA.toBase58(), refB.toBase58()] }),
    "1",
    sender.toBase58(),
  );
  const base64 = proposalBase64(result);
  const tx = decode(base64);

  const keys = tx.instructions[0]!.keys;
  const refKeys = keys.filter((k) => k.pubkey.equals(refA) || k.pubkey.equals(refB));
  assert.equal(refKeys.length, 2);
  assert.ok(refKeys.every((k) => !k.isSigner && !k.isWritable));
});

test("SOL transfer: memo is the first instruction with utf8 data and no keys", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const result = buildSolanaProposal(
    makeRequest("SOL", recipient.toBase58(), { memo: "thanks for lunch" }),
    "1",
    sender.toBase58(),
  );
  const base64 = proposalBase64(result);
  const tx = decode(base64);

  assert.equal(tx.instructions.length, 2);
  const memo = tx.instructions[0]!;
  assert.equal(memo.programId.toBase58(), MEMO_PROGRAM_ID);
  assert.equal(memo.keys.length, 0);
  assert.equal(memo.data.toString("utf8"), "thanks for lunch");
});

test("SOL transfer: output carries the solana proposal envelope", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const result = buildSolanaProposal(makeRequest("SOL", recipient.toBase58()), "7", sender.toBase58());
  const proposal = result.structuredContent["io.paybox/transactionProposal"] as {
    kind: string;
    chain: string;
    transaction: { transactionBase64: string };
  };
  assert.equal(proposal.kind, "solana");
  assert.equal(proposal.chain, "solana:mainnet");
  assert.equal(Buffer.from(proposal.transaction.transactionBase64, "base64").toString("base64"), proposal.transaction.transactionBase64);
});

// ---------------------------------------------------------------------------
// buildSolanaProposal — USDC
// ---------------------------------------------------------------------------

test("USDC: builds createATA then transferChecked in order", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const result = buildSolanaProposal(makeRequest("USDC", recipient.toBase58()), "2500000", sender.toBase58());
  const base64 = proposalBase64(result);
  const tx = decode(base64);

  assert.equal(tx.instructions.length, 2);
  assert.equal(tx.instructions[0]!.programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  assert.equal(tx.instructions[1]!.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58());
});

test("USDC: createATA uses correct payer, owner, mint and program id", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const mint = new PublicKey(SOLANA_USDC_MINT);
  const recipientAta = getAssociatedTokenAddressSync(mint, recipient);
  const result = buildSolanaProposal(makeRequest("USDC", recipient.toBase58()), "1", sender.toBase58());
  const base64 = proposalBase64(result);
  const tx = decode(base64);

  const createAta = tx.instructions[0]!;
  assert.equal(createAta.programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  assert.ok(createAta.keys[0]!.pubkey.equals(sender) && createAta.keys[0]!.isSigner);
  assert.ok(createAta.keys[1]!.pubkey.equals(recipientAta) && createAta.keys[1]!.isWritable);
  assert.ok(createAta.keys[2]!.pubkey.equals(recipient));
  assert.ok(createAta.keys[3]!.pubkey.equals(mint));
  assert.equal(createAta.data.toString("hex"), "01");
});

test("USDC: transferChecked encodes amount and 6 decimals", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const amount = "2500000";
  const result = buildSolanaProposal(makeRequest("USDC", recipient.toBase58()), amount, sender.toBase58());
  const base64 = proposalBase64(result);
  const tx = decode(base64);

  const transfer = tx.instructions[1]!;
  assert.equal(transfer.data[0], 12);
  assert.equal(transfer.data.readBigUInt64LE(1), BigInt(amount));
  assert.equal(transfer.data[9], 6);
});

test("USDC: transferChecked uses sender/recipient ATAs and the USDC mint", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const mint = new PublicKey(SOLANA_USDC_MINT);
  const senderAta = getAssociatedTokenAddressSync(mint, sender);
  const recipientAta = getAssociatedTokenAddressSync(mint, recipient);
  const result = buildSolanaProposal(makeRequest("USDC", recipient.toBase58()), "1", sender.toBase58());
  const base64 = proposalBase64(result);
  const tx = decode(base64);

  const transfer = tx.instructions[1]!;
  assert.ok(transfer.keys[0]!.pubkey.equals(senderAta));
  assert.ok(transfer.keys[1]!.pubkey.equals(mint));
  assert.ok(transfer.keys[2]!.pubkey.equals(recipientAta));
  assert.ok(transfer.keys[3]!.pubkey.equals(sender) && transfer.keys[3]!.isSigner);
});

test("USDC: appends references to the transferChecked instruction", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const ref = Keypair.generate().publicKey;
  const result = buildSolanaProposal(
    makeRequest("USDC", recipient.toBase58(), { references: [ref.toBase58()] }),
    "1",
    sender.toBase58(),
  );
  const base64 = proposalBase64(result);
  const tx = decode(base64);

  const transfer = tx.instructions[1]!;
  const refKey = transfer.keys.find((k) => k.pubkey.equals(ref));
  assert.ok(refKey);
  assert.ok(!refKey.isSigner && !refKey.isWritable);
});

test("USDC: memo sits immediately before transferChecked (Solana Pay spec)", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const result = buildSolanaProposal(
    makeRequest("USDC", recipient.toBase58(), { memo: "hi" }),
    "1",
    sender.toBase58(),
  );
  const base64 = proposalBase64(result);
  const tx = decode(base64);

  assert.equal(tx.instructions.length, 3);
  assert.equal(tx.instructions[0]!.programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  assert.equal(tx.instructions[1]!.programId.toBase58(), MEMO_PROGRAM_ID);
  assert.equal(tx.instructions[2]!.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58());
});

test("USDC: a program-derived recipient (vault) builds; its ATA is derived off-curve", () => {
  const sender = Keypair.generate().publicKey;
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("vault")], new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"));
  const tx = decode(proposalBase64(buildSolanaProposal(makeRequest("USDC", pda.toBase58()), "1000000", sender.toBase58())));
  const ata = getAssociatedTokenAddressSync(new PublicKey(SOLANA_USDC_MINT), pda, true);
  assert.ok(tx.instructions[1]!.keys.some((k) => k.pubkey.equals(ata)));
});

// ---------------------------------------------------------------------------
// buildSolanaProposal — validation
// ---------------------------------------------------------------------------

function expectPayLinkError(code: string, fn: () => unknown) {
  assert.throws(fn, (err: unknown) => err instanceof PayLinkError && err.code === code, `expected PayLinkError(${code})`);
}

test("rejects empty sender as invalid_sender", () => {
  const recipient = Keypair.generate().publicKey;
  expectPayLinkError("invalid_sender", () =>
    buildSolanaProposal(makeRequest("SOL", recipient.toBase58()), "1", ""),
  );
});

test("rejects whitespace sender as invalid_sender", () => {
  const recipient = Keypair.generate().publicKey;
  expectPayLinkError("invalid_sender", () =>
    buildSolanaProposal(makeRequest("SOL", recipient.toBase58()), "1", "  \t\n"),
  );
});

test("rejects unicode sender as invalid_sender", () => {
  const recipient = Keypair.generate().publicKey;
  expectPayLinkError("invalid_sender", () =>
    buildSolanaProposal(makeRequest("SOL", recipient.toBase58()), "1", "\u2713valid?!"),
  );
});

test("rejects non-base58 characters (0, O, I, l) as invalid_sender", () => {
  const recipient = Keypair.generate().publicKey;
  expectPayLinkError("invalid_sender", () =>
    buildSolanaProposal(makeRequest("SOL", recipient.toBase58()), "1", "0OIl0OIl0OIl0OIl"),
  );
});

test("rejects wrong-length base58 sender as invalid_sender", () => {
  const recipient = Keypair.generate().publicKey;
  expectPayLinkError("invalid_sender", () =>
    buildSolanaProposal(makeRequest("SOL", recipient.toBase58()), "1", "tooShort"),
  );
});

test("rejects hex/0x-prefixed sender as invalid_sender", () => {
  const recipient = Keypair.generate().publicKey;
  expectPayLinkError("invalid_sender", () =>
    buildSolanaProposal(makeRequest("SOL", recipient.toBase58()), "1", "0xdeadbeef"),
  );
});

test("rejects a valid-alphabet base58 sender that decodes to the wrong length", () => {
  const recipient = Keypair.generate().publicKey;
  expectPayLinkError("invalid_sender", () =>
    buildSolanaProposal(makeRequest("SOL", recipient.toBase58()), "1", "z".repeat(44)),
  );
});

test("rejects sender equal to recipient as self_payment", () => {
  const who = Keypair.generate().publicKey;
  expectPayLinkError("self_payment", () =>
    buildSolanaProposal(makeRequest("SOL", who.toBase58()), "1", who.toBase58()),
  );
});

test("rejects self_payment for USDC links too", () => {
  const who = Keypair.generate().publicKey;
  expectPayLinkError("self_payment", () =>
    buildSolanaProposal(makeRequest("USDC", who.toBase58()), "1", who.toBase58()),
  );
});

test("rejects negative amount as invalid_amount", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  expectPayLinkError("invalid_amount", () =>
    buildSolanaProposal(makeRequest("SOL", recipient.toBase58()), "-1", sender.toBase58()),
  );
});

test("rejects empty amount as invalid_amount", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  expectPayLinkError("invalid_amount", () =>
    buildSolanaProposal(makeRequest("SOL", recipient.toBase58()), "", sender.toBase58()),
  );
});

test("rejects fractional amount as invalid_amount", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  expectPayLinkError("invalid_amount", () =>
    buildSolanaProposal(makeRequest("SOL", recipient.toBase58()), "1.5", sender.toBase58()),
  );
});

test("rejects non-numeric amount as invalid_amount", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  expectPayLinkError("invalid_amount", () =>
    buildSolanaProposal(makeRequest("SOL", recipient.toBase58()), "abc", sender.toBase58()),
  );
});

test("rejects amount at or above 2^64 as invalid_amount", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  expectPayLinkError("invalid_amount", () =>
    buildSolanaProposal(makeRequest("SOL", recipient.toBase58()), U64_MAX.toString(), sender.toBase58()),
  );
});

test("rejects leading-zero amount as invalid_amount", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  expectPayLinkError("invalid_amount", () =>
    buildSolanaProposal(makeRequest("SOL", recipient.toBase58()), "007", sender.toBase58()),
  );
});

test("accepts a zero amount", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const result = buildSolanaProposal(makeRequest("SOL", recipient.toBase58()), "0", sender.toBase58());
  const base64 = proposalBase64(result);
  const tx = decode(base64);
  assert.equal(tx.instructions[0]!.data.readBigUInt64LE(4), 0n);
});

test("accepts the maximum u64 amount (2^64 - 1)", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const max = (U64_MAX - 1n).toString();
  const result = buildSolanaProposal(makeRequest("SOL", recipient.toBase58()), max, sender.toBase58());
  const base64 = proposalBase64(result);
  const tx = decode(base64);
  assert.equal(tx.instructions[0]!.data.readBigUInt64LE(4), U64_MAX - 1n);
});

test("rejects an unsupported asset (ETH) as unsupported_token", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const req = makeRequest("SOL", recipient.toBase58(), { asset: { symbol: "ETH", decimals: 18 } });
  expectPayLinkError("unsupported_token", () => buildSolanaProposal(req, "1", sender.toBase58()));
});

test("rejects a Base link as unsupported_chain", () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const req = makeRequest("SOL", recipient.toBase58(), {
    chain: "base",
    caip2: "eip155:8453",
    standard: "eip681",
  });
  expectPayLinkError("unsupported_chain", () => buildSolanaProposal(req, "1", sender.toBase58()));
});


// ---------------------------------------------------------------------------
// checkSolanaRecipient (one getMultipleAccounts call)
// ---------------------------------------------------------------------------

type Acc = Record<string, unknown> | null;
function multiFake(byKey: Record<string, Acc>, opts: { fail?: boolean } = {}) {
  const calls: { method: string; keys: string[] }[] = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: [string[]] };
    calls.push({ method: body.method, keys: body.params[0] });
    if (opts.fail) return new Response("busy", { status: 429 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: body.params[0].map((k) => byKey[k] ?? null) } }));
  }) as typeof fetch;
  return { fetchFn, calls };
}
const usdcMint = new PublicKey(SOLANA_USDC_MINT);
const ataOf = (owner: PublicKey) => getAssociatedTokenAddressSync(usdcMint, owner, true).toBase58();
const tokenAcc = (amount: string, state = "initialized"): Acc => ({
  lamports: 2_039_280, owner: TOKEN_PROGRAM_ID.toBase58(), executable: false,
  data: { parsed: { info: { state, mint: SOLANA_USDC_MINT, tokenAmount: { amount, decimals: 6 } }, type: "account" }, program: "spl-token" },
});
const wallet = (lamports: number): Acc => ({ lamports, owner: SystemProgram.programId.toBase58(), executable: false, data: ["", "base64"] });
const statusOf = (checks: { id: string; status: string }[], id: string) => checks.find((c) => c.id === id)?.status;

test("SOL: system-owned on-curve recipient passes, one RPC call", async () => {
  const r = Keypair.generate().publicKey;
  const { fetchFn, calls } = multiFake({ [r.toBase58()]: wallet(5_000_000) });
  const checks = await checkSolanaRecipient(makeRequest("SOL", r.toBase58(), { atomicAmount: "1000000", amount: "0.001" }), fetchFn);
  assert.deepEqual(checks.map((c) => [c.id, c.status]), [["solana_recipient_type", "pass"]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "getMultipleAccounts");
});

test("SOL: nonexistent recipient warns", async () => {
  const r = Keypair.generate().publicKey;
  const { fetchFn } = multiFake({});
  const checks = await checkSolanaRecipient(makeRequest("SOL", r.toBase58(), { atomicAmount: "5000000", amount: "0.005" }), fetchFn);
  assert.equal(statusOf(checks, "solana_recipient_type"), "warn");
});

test("SOL: nonexistent recipient and amount below rent minimum fails", async () => {
  const r = Keypair.generate().publicKey;
  const { fetchFn } = multiFake({});
  const checks = await checkSolanaRecipient(makeRequest("SOL", r.toBase58(), { atomicAmount: "890879", amount: "0.000890879" }), fetchFn);
  assert.equal(statusOf(checks, "solana_recipient_type"), "fail");
  assert.match(checks[0]!.detail, /0\.00089088 SOL minimum/);
});

test("token account and Token-2022 account recipients fail", async () => {
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const r = Keypair.generate().publicKey;
    const { fetchFn } = multiFake({ [r.toBase58()]: { lamports: 2_039_280, owner: program.toBase58(), executable: false } });
    const checks = await checkSolanaRecipient(makeRequest("SOL", r.toBase58()), fetchFn);
    assert.equal(statusOf(checks, "solana_recipient_type"), "fail");
  }
});

test("executable program recipient fails", async () => {
  const r = Keypair.generate().publicKey;
  const { fetchFn } = multiFake({ [r.toBase58()]: { lamports: 1, owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true } });
  assert.equal(statusOf(await checkSolanaRecipient(makeRequest("SOL", r.toBase58()), fetchFn), "solana_recipient_type"), "fail");
});

test("data account owned by another program warns", async () => {
  const r = Keypair.generate().publicKey;
  const { fetchFn } = multiFake({ [r.toBase58()]: { lamports: 1, owner: "Stake11111111111111111111111111111111111111", executable: false } });
  const checks = await checkSolanaRecipient(makeRequest("SOL", r.toBase58()), fetchFn);
  assert.equal(statusOf(checks, "solana_recipient_type"), "warn");
  assert.match(checks[0]!.detail, /Stake1111/);
});

test("program-derived (off-curve) system account warns as a vault", async () => {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("vault")], new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"));
  const { fetchFn } = multiFake({ [pda.toBase58()]: wallet(10_000_000) });
  const checks = await checkSolanaRecipient(makeRequest("USDC", pda.toBase58()), fetchFn);
  assert.equal(statusOf(checks, "solana_recipient_type"), "warn");
  assert.match(checks[0]!.detail, /multisig vault/);
});

test("USDC: missing recipient ATA is a pass that mentions the rent", async () => {
  const r = Keypair.generate().publicKey;
  const { fetchFn, calls } = multiFake({ [r.toBase58()]: wallet(1_000_000) });
  const checks = await checkSolanaRecipient(makeRequest("USDC", r.toBase58()), fetchFn);
  assert.equal(statusOf(checks, "solana_recipient_usdc_account"), "pass");
  assert.match(checks[1]!.detail, /creates it/);
  assert.deepEqual(calls[0]!.keys, [r.toBase58(), ataOf(r)]);
});

test("USDC: frozen recipient ATA fails", async () => {
  const r = Keypair.generate().publicKey;
  const { fetchFn } = multiFake({ [r.toBase58()]: wallet(1_000_000), [ataOf(r)]: tokenAcc("0", "frozen") });
  assert.equal(statusOf(await checkSolanaRecipient(makeRequest("USDC", r.toBase58()), fetchFn), "solana_recipient_usdc_account"), "fail");
});

test("USDC: ATA address holding a non-token account fails", async () => {
  const r = Keypair.generate().publicKey;
  const { fetchFn } = multiFake({ [r.toBase58()]: wallet(1_000_000), [ataOf(r)]: wallet(1) });
  assert.equal(statusOf(await checkSolanaRecipient(makeRequest("USDC", r.toBase58()), fetchFn), "solana_recipient_usdc_account"), "fail");
});

test("sender: USDC balance below the amount fails with both numbers", async () => {
  const r = Keypair.generate().publicKey;
  const s = Keypair.generate().publicKey;
  const { fetchFn, calls } = multiFake({ [r.toBase58()]: wallet(1_000_000), [ataOf(r)]: tokenAcc("0"), [s.toBase58()]: wallet(50_000_000), [ataOf(s)]: tokenAcc("3000000") });
  const checks = await checkSolanaRecipient(makeRequest("USDC", r.toBase58(), { atomicAmount: "19990000", amount: "19.99" }), fetchFn, s.toBase58());
  assert.equal(statusOf(checks, "solana_sender_balance"), "fail");
  assert.match(checks[2]!.detail, /has 3 USDC.*19\.99 USDC/);
  assert.equal(calls[0]!.keys.length, 4);
});

test("sender: enough USDC but no SOL for fees and new ATA rent fails", async () => {
  const r = Keypair.generate().publicKey;
  const s = Keypair.generate().publicKey;
  const { fetchFn } = multiFake({ [r.toBase58()]: wallet(1_000_000), [s.toBase58()]: wallet(1_000_000), [ataOf(s)]: tokenAcc("50000000") });
  const checks = await checkSolanaRecipient(makeRequest("USDC", r.toBase58(), { atomicAmount: "19990000", amount: "19.99" }), fetchFn, s.toBase58());
  assert.equal(statusOf(checks, "solana_sender_balance"), "fail");
  assert.match(checks[2]!.detail, /new USDC account/);
});

test("sender: enough USDC and SOL passes", async () => {
  const r = Keypair.generate().publicKey;
  const s = Keypair.generate().publicKey;
  const { fetchFn } = multiFake({ [r.toBase58()]: wallet(1_000_000), [ataOf(r)]: tokenAcc("0"), [s.toBase58()]: wallet(20_000_000), [ataOf(s)]: tokenAcc("50000000") });
  const checks = await checkSolanaRecipient(makeRequest("USDC", r.toBase58(), { atomicAmount: "19990000", amount: "19.99" }), fetchFn, s.toBase58());
  assert.equal(statusOf(checks, "solana_sender_balance"), "pass");
});

test("sender: SOL payment above balance plus fees fails", async () => {
  const r = Keypair.generate().publicKey;
  const s = Keypair.generate().publicKey;
  const { fetchFn } = multiFake({ [r.toBase58()]: wallet(1_000_000), [s.toBase58()]: wallet(1_000_000_000) });
  const checks = await checkSolanaRecipient(makeRequest("SOL", r.toBase58(), { atomicAmount: "1000000000", amount: "1" }), fetchFn, s.toBase58());
  assert.equal(statusOf(checks, "solana_sender_balance"), "fail");
});

test("RPC failure gives unknown for every check and never throws", async () => {
  const r = Keypair.generate().publicKey;
  const s = Keypair.generate().publicKey;
  const { fetchFn } = multiFake({}, { fail: true });
  const checks = await checkSolanaRecipient(makeRequest("USDC", r.toBase58()), fetchFn, s.toBase58());
  assert.deepEqual(checks.map((c) => c.status), ["unknown", "unknown", "unknown"]);
});

test("a rejecting fetch or a malformed response gives unknown", async () => {
  const r = Keypair.generate().publicKey;
  const rejecting = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
  assert.equal((await checkSolanaRecipient(makeRequest("SOL", r.toBase58()), rejecting))[0]!.status, "unknown");
  const short = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [] } }))) as unknown as typeof fetch;
  assert.equal((await checkSolanaRecipient(makeRequest("SOL", r.toBase58()), short))[0]!.status, "unknown");
});

test("posts to the Solana RPC host with jsonParsed and a timeout signal", async () => {
  const r = Keypair.generate().publicKey;
  let seen: { url: string; init?: RequestInit } | null = null;
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [null] } }));
  }) as typeof fetch;
  await checkSolanaRecipient(makeRequest("SOL", r.toBase58()), fetchFn);
  assert.equal(seen!.url, HOSTS.solanaRpc);
  assert.ok(seen!.init?.signal instanceof AbortSignal);
  assert.match(String(seen!.init?.body), /jsonParsed/);
});

test("USDC recipient with no SOL account but a live USDC account passes", async () => {
  const r = Keypair.generate().publicKey;
  const { fetchFn } = multiFake({ [ataOf(r)]: tokenAcc("1234000000") });
  const checks = await checkSolanaRecipient(makeRequest("USDC", r.toBase58(), { atomicAmount: "1000000", amount: "1" }), fetchFn);
  assert.equal(statusOf(checks, "solana_recipient_type"), "pass");
  assert.match(checks[0]!.detail, /holds no SOL but already has a USDC account/);
});

test("sender: a SOL payment that would leave the wallet below the rent minimum fails", async () => {
  const r = Keypair.generate().publicKey;
  const s = Keypair.generate().publicKey;
  const { fetchFn } = multiFake({ [r.toBase58()]: wallet(1_000_000), [s.toBase58()]: wallet(1_000_100_001) });
  const checks = await checkSolanaRecipient(makeRequest("SOL", r.toBase58(), { atomicAmount: "1000000000", amount: "1" }), fetchFn, s.toBase58());
  assert.equal(statusOf(checks, "solana_sender_balance"), "fail");
  assert.match(checks[1]!.detail, /a wallet must keep/);
});
