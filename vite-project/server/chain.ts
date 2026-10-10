import {
  createClient,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  signature,
} from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer } from "@solana/kit-plugin-signer";
import { getAddMemoInstruction } from "@solana-program/memo";
import { db, ensure } from "./db";
import { hash } from "./math";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const chainEnabled = () =>
  process.env.SOLANA_ENABLED === "true" && !!process.env.SOLANA_SECRET_KEY;
const url = () => process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const memo = (kind: string, digest: string) =>
  `scarlet:rutgers-v1:${kind}:${digest}`;
async function devnet() {
  const rpc = createSolanaRpc(url()),
    official = createSolanaRpc("https://api.devnet.solana.com");
  ensure(
    (await rpc.getGenesisHash().send()) ===
      (await official.getGenesisHash().send()),
    "WRONG_SOLANA_NETWORK",
  );
  return rpc;
}
async function signingClient() {
  const key = await createKeyPairSignerFromBytes(
    Uint8Array.from(JSON.parse(process.env.SOLANA_SECRET_KEY!)),
  );
  return createClient()
    .use(signer(key))
    .use(
      solanaRpc({
        rpcUrl: url(),
        transactionConfig: { version: 1 },
        skipPreflight: false,
      }),
    );
}
export async function enqueueCommitments() {
  if (!chainEnabled()) return;
  const client = await signingClient();
  for (const m of await db.market.findMany({
    where: { status: "DRAFT" },
    take: 100,
  })) {
    await db.chainCommitment.upsert({
      where: { marketId_kind: { marketId: m.id, kind: "RULES" } },
      update: {},
      create: {
        environmentId: m.environmentId,
        marketId: m.id,
        kind: "RULES",
        canonicalizationVersion: "rutgers-v1",
        payloadHash: m.ruleHash,
        signerPublicKey: client.identity.address,
      },
    });
  }
  for (const s of await db.settlement.findMany({
    where: {},
    take: 1000,
    orderBy: { settledAt: "desc" },
  })) {
    await db.chainCommitment.upsert({
      where: { marketId_kind: { marketId: s.marketId, kind: "SETTLEMENT" } },
      update: {},
      create: {
        environmentId: s.environmentId,
        marketId: s.marketId,
        settlementId: s.id,
        kind: "SETTLEMENT",
        canonicalizationVersion: "rutgers-v1",
        payloadHash: s.receiptHash,
        signerPublicKey: client.identity.address,
      },
    });
  }
}
export function validatePublishedMemo(
  tx: {
    meta: { err: unknown } | null;
    transaction: {
      message: {
        accountKeys: readonly { pubkey: string; signer: boolean }[];
        instructions: readonly unknown[];
      };
    };
  },
  expectedSigner: string,
  kind: string,
  digest: string,
) {
  return (
    !!tx.meta &&
    tx.meta.err === null &&
    tx.transaction.message.accountKeys.some(
      (k) => k.pubkey === expectedSigner && k.signer,
    ) &&
    tx.transaction.message.instructions.some((raw) => {
      const i = raw as { programId?: string; parsed?: unknown };
      return i.programId === MEMO && i.parsed === memo(kind, digest);
    })
  );
}
export async function verifyCommitment(marketId: string, kind = "SETTLEMENT") {
  const c = await db.chainCommitment.findUnique({
    where: { marketId_kind: { marketId, kind } },
  });
  if (!c?.transactionSignature) return { status: c?.status ?? "UNAVAILABLE" };
  const m = await db.market.findUniqueOrThrow({ where: { id: marketId } }),
    s =
      kind === "SETTLEMENT"
        ? await db.settlement.findUniqueOrThrow({ where: { marketId } })
        : null,
    expected = hash(s ? s.receipt : m.resolutionRule);
  ensure(
    expected === c.payloadHash && c.network === "devnet",
    "COMMITMENT_HASH_MISMATCH",
  );
  const rpc = await devnet(),
    tx = await rpc
      .getTransaction(signature(c.transactionSignature), {
        encoding: "jsonParsed",
        commitment: "confirmed",
        maxSupportedTransactionVersion: 1,
      })
      .send();
  if (!tx) return { status: "PENDING" };
  ensure(
    validatePublishedMemo(tx, c.signerPublicKey, kind, expected),
    "COMMITMENT_VERIFICATION_FAILED",
  );
  return {
    status: "CONFIRMED",
    network: "devnet",
    payloadHash: expected,
    signer: c.signerPublicKey,
    signature: c.transactionSignature,
    precommitted:
      kind === "RULES" &&
      tx.blockTime !== null &&
      Number(tx.blockTime) * 1000 < m.opensAt.getTime(),
    explorerUrl: `https://explorer.solana.com/tx/${c.transactionSignature}?cluster=devnet`,
    meaning:
      "Verifies publication and integrity, not truth of the real-world outcome.",
  };
}
export async function processCommitments() {
  if (!chainEnabled()) return;
  await enqueueCommitments();
  await devnet();
  const client = await signingClient();
  for (const job of await db.chainCommitment.findMany({
    where: { status: { not: "CONFIRMED" }, nextAttemptAt: { lte: new Date() } },
    take: 5,
  })) {
    const claimed = await db.chainCommitment.updateMany({
      where: { id: job.id, nextAttemptAt: { lte: new Date() } },
      data: {
        nextAttemptAt: new Date(Date.now() + 120000),
        attempts: { increment: 1 },
      },
    });
    if (!claimed.count) continue;
    try {
      ensure(client.identity.address === job.signerPublicKey, "SIGNER_CHANGED");
      if (!job.transactionSignature) {
        const { context } = await client.sendTransaction([
          getAddMemoInstruction({
            memo: memo(job.kind, job.payloadHash),
            signers: [client.identity],
          }),
        ]);
        await db.chainCommitment.update({
          where: { id: job.id },
          data: {
            transactionSignature: context.signature,
            status: "SUBMITTED",
          },
        });
      }
      const result = await verifyCommitment(job.marketId, job.kind);
      await db.chainCommitment.update({
        where: { id: job.id },
        data: {
          status: result.status,
          confirmedAt: result.status === "CONFIRMED" ? new Date() : null,
          lastError: null,
          nextAttemptAt: new Date(Date.now() + 30000),
        },
      });
    } catch {
      await db.chainCommitment.update({
        where: { id: job.id },
        data: {
          status: "PENDING",
          lastError: "DEVNET_UNAVAILABLE",
          nextAttemptAt: new Date(Date.now() + 60000),
        },
      });
    }
  }
}
