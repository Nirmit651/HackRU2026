import { z } from "zod";
import { ruleSchema, marketCategories } from "../shared/contracts";
import { transaction, lockEnvironment, lockWallets, ensure, clock } from "./db";
import { transfer } from "./engine";
import { hash } from "./math";
export const createMarketInput = z.object({
  environmentId: z.uuid(),
  slug: z.string().regex(/^[a-z0-9-]{3,80}$/),
  title: z.string().min(10).max(180),
  description: z.string().max(2000),
  category: z.enum(marketCategories),
  opensAt: z.iso.datetime(),
  closesAt: z.iso.datetime(),
  expectedResolutionAt: z.iso.datetime(),
  sourceUrl: z.url(),
  resolutionRule: ruleSchema,
  context: z.record(z.string(), z.unknown()).default({}),
  generatorKey: z.string().min(1).max(250).optional(),
  templateVersion: z.number().int().positive().optional(),
  liquidityBMicros: z
    .string()
    .regex(/^\d{7,10}$/)
    .default("100000000"),
});
export async function createMarket(raw: unknown) {
  const input = createMarketInput.parse(raw),
    rule = input.resolutionRule;
  ensure(
    rule.cutoff === input.closesAt &&
      (rule.automation ||
        new Date(rule.windowStart) > new Date(input.closesAt)) &&
      new Date(rule.windowEnd) >= new Date(rule.windowStart) &&
      new Date(rule.voidAfter) >= new Date(rule.windowEnd),
    "INVALID_WINDOW",
  );
  ensure(new Date(input.opensAt) < new Date(input.closesAt), "INVALID_WINDOW");
  return transaction(async (tx) => {
    const env = await lockEnvironment(tx, input.environmentId);
    if (input.generatorKey) {
      const existing = await tx.market.findUnique({
        where: {
          environmentId_generatorKey: {
            environmentId: env.id,
            generatorKey: input.generatorKey,
          },
        },
      });
      if (existing) return { ...existing, creationReplayed: true };
      ensure(
        (await clock(tx, env.id)) < new Date(input.closesAt),
        "AUTOMATION_CUTOFF_PASSED",
      );
      ensure(
        rule.automation && input.templateVersion === rule.automation.version,
        "INVALID_AUTOMATION_RULE",
      );
    }
    ensure(
      env.kind === "DEMO" || !rule.provider.startsWith("demo"),
      "SIMULATED_LIVE_RULE",
    );
    const treasury = await tx.wallet.findFirstOrThrow({
        where: { environmentId: env.id, kind: "TREASURY" },
      }),
      maker = await tx.wallet.create({
        data: { environmentId: env.id, kind: "MARKET_MAKER" },
      });
    await lockWallets(tx, [treasury.id, maker.id]);
    const m = await tx.market.create({
      data: {
        ...input,
        context: input.context as never,
        provider: rule.provider,
        externalEventId: rule.externalEventId,
        ruleHash: hash(rule),
        marketMakerWalletId: maker.id,
        liquidityBMicros: BigInt(input.liquidityBMicros),
      },
    });
    await transfer(
      tx,
      env.id,
      treasury.id,
      maker.id,
      m.liquidityBMicros,
      "MARKET_FUNDING",
      `fund:${m.id}`,
      m.id,
      await clock(tx, env.id),
    );
    return { ...m, creationReplayed: false };
  });
}
export async function createLive(key: string) {
  return transaction(async (tx) => {
    const env = await tx.environment.create({
      data: { key, kind: "LIVE", initialSupplyMicros: 1000000000000n },
    });
    await tx.wallet.create({
      data: {
        environmentId: env.id,
        kind: "TREASURY",
        balanceMicros: env.initialSupplyMicros,
        openingBalanceMicros: env.initialSupplyMicros,
      },
    });
    return env;
  });
}
