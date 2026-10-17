import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import * as ref from "@solana/spl-token";
import * as mine from "../src/spl.js";

const MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const same = (a: TransactionInstruction, b: TransactionInstruction) => {
  assert.equal(a.programId.toBase58(), b.programId.toBase58());
  assert.deepEqual(a.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), b.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]));
  assert.equal(Buffer.from(a.data).toString("hex"), Buffer.from(b.data).toString("hex"));
};

test("program IDs match @solana/spl-token", () => {
  assert.ok(mine.TOKEN_PROGRAM_ID.equals(ref.TOKEN_PROGRAM_ID));
  assert.ok(mine.TOKEN_2022_PROGRAM_ID.equals(ref.TOKEN_2022_PROGRAM_ID));
  assert.ok(mine.ASSOCIATED_TOKEN_PROGRAM_ID.equals(ref.ASSOCIATED_TOKEN_PROGRAM_ID));
});

test("ATA address matches for 50 random owners and a known wallet", () => {
  for (let i = 0; i < 50; i++) {
    const owner = Keypair.generate().publicKey;
    assert.ok(mine.getAssociatedTokenAddressSync(MINT, owner).equals(ref.getAssociatedTokenAddressSync(MINT, owner)));
  }
  const known = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
  assert.ok(mine.getAssociatedTokenAddressSync(MINT, known).equals(ref.getAssociatedTokenAddressSync(MINT, known)));
});

test("off-curve owner: throws by default, matches the reference when allowed", () => {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("vault")], new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"));
  assert.throws(() => mine.getAssociatedTokenAddressSync(MINT, pda));
  assert.throws(() => ref.getAssociatedTokenAddressSync(MINT, pda));
  assert.ok(mine.getAssociatedTokenAddressSync(MINT, pda, true).equals(ref.getAssociatedTokenAddressSync(MINT, pda, true)));
});

test("CreateIdempotent instruction is byte-identical", () => {
  const payer = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const ata = ref.getAssociatedTokenAddressSync(MINT, owner);
  same(mine.createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, MINT), ref.createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, MINT));
});

test("TransferChecked instruction is byte-identical across amount edge cases", () => {
  const [src, dst, owner] = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
  for (const amount of [0n, 1n, 19_990_000n, 2n ** 32n, 2n ** 53n + 1n, 2n ** 64n - 1n]) {
    same(mine.createTransferCheckedInstruction(src, MINT, dst, owner, amount, 6), ref.createTransferCheckedInstruction(src, MINT, dst, owner, amount, 6));
  }
});

test("TransferChecked rejects amounts outside u64", () => {
  const k = Keypair.generate().publicKey;
  assert.throws(() => mine.createTransferCheckedInstruction(k, MINT, k, k, 2n ** 64n, 6));
  assert.throws(() => mine.createTransferCheckedInstruction(k, MINT, k, k, -1n, 6));
});
