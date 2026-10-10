import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "../generated/prisma/client";
export const db = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: 24,
    connectionTimeoutMillis: 5000,
    options: "-c timezone=UTC",
  }),
});
export type Tx = Prisma.TransactionClient;
export async function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(fn, { timeout: 20000, maxWait: 10000 });
    } catch (e) {
      if (
        attempt < 3 &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2034", "P2002"].includes(e.code)
      ) {
        await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}
export class AppError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export function ensure(
  condition: unknown,
  code: string,
  status = 400,
): asserts condition {
  if (!condition) throw new AppError(code, status);
}
export async function lockEnvironment(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM environments WHERE id=${id}::uuid FOR UPDATE`;
  return tx.environment.findUniqueOrThrow({ where: { id } });
}
export async function lockMarket(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM markets WHERE id=${id}::uuid FOR UPDATE`;
  const m = await tx.market.findUnique({ where: { id } });
  ensure(m, "NOT_FOUND", 404);
  return m;
}
export async function lockWallets(tx: Tx, ids: string[]) {
  for (const id of [...new Set(ids)].sort())
    await tx.$queryRaw`SELECT id FROM wallets WHERE id=${id}::uuid FOR UPDATE`;
}
export async function clock(tx: Tx, environmentId: string) {
  const env = await tx.environment.findUniqueOrThrow({
    where: { id: environmentId },
  });
  if (env.kind === "DEMO") return env.virtualNow!;
  const [row] = await tx.$queryRaw<
    { millis: bigint }[]
  >`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS millis`;
  return new Date(Number(row.millis));
}
