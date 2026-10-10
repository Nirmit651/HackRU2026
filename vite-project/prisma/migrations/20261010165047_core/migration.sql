-- CreateEnum
CREATE TYPE "Campus" AS ENUM ('BUSCH', 'LIVINGSTON', 'COLLEGE_AVE', 'COOK_DOUGLASS', 'OTHER');

-- CreateEnum
CREATE TYPE "ProfileKind" AS ENUM ('HUMAN', 'BOT');

-- CreateEnum
CREATE TYPE "EnvironmentKind" AS ENUM ('LIVE', 'DEMO');

-- CreateEnum
CREATE TYPE "WalletKind" AS ENUM ('USER', 'TREASURY', 'MARKET_MAKER');

-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('DRAFT', 'OPEN', 'PAUSED', 'CLOSED', 'RESOLVED', 'VOIDED');

-- CreateEnum
CREATE TYPE "Category" AS ENUM ('TEMPERATURE', 'BUS_ARRIVAL', 'RAINFALL', 'CONCERT', 'STUDENT_ELECTION', 'VARSITY_SPORTS');

-- CreateEnum
CREATE TYPE "ContractSide" AS ENUM ('YES', 'NO');

-- CreateEnum
CREATE TYPE "SettlementOutcome" AS ENUM ('YES', 'NO', 'VOID');

-- CreateEnum
CREATE TYPE "TransferKind" AS ENUM ('STARTING_GRANT', 'MARKET_FUNDING', 'TRADE', 'PAYOUT', 'VOID_REFUND');

-- CreateEnum
CREATE TYPE "MarketEventKind" AS ENUM ('OPENED', 'PRICE_CHANGED', 'STATUS_CHANGED', 'SETTLED');

-- CreateTable
CREATE TABLE "profiles" (
    "id" UUID NOT NULL,
    "authUserId" UUID,
    "handle" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "campus" "Campus" NOT NULL DEFAULT 'OTHER',
    "kind" "ProfileKind" NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "environments" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "EnvironmentKind" NOT NULL,
    "initialSupplyMicros" BIGINT NOT NULL,
    "startingGrantMicros" BIGINT NOT NULL DEFAULT 1000000000,
    "seed" INTEGER,
    "scenarioVersion" TEXT,
    "simulatedStartAt" TIMESTAMPTZ,
    "virtualNow" TIMESTAMPTZ,
    "runState" TEXT NOT NULL DEFAULT 'PAUSED',
    "speed" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "environments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "profileId" UUID,
    "kind" "WalletKind" NOT NULL,
    "balanceMicros" BIGINT NOT NULL DEFAULT 0,
    "openingBalanceMicros" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "markets" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "Category" NOT NULL,
    "status" "MarketStatus" NOT NULL DEFAULT 'DRAFT',
    "opensAt" TIMESTAMPTZ NOT NULL,
    "closesAt" TIMESTAMPTZ NOT NULL,
    "expectedResolutionAt" TIMESTAMPTZ NOT NULL,
    "displayTimezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "ruleVersion" INTEGER NOT NULL DEFAULT 1,
    "resolutionRule" JSONB NOT NULL,
    "ruleHash" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "externalEventId" TEXT,
    "context" JSONB NOT NULL,
    "marketMakerWalletId" UUID NOT NULL,
    "liquidityBMicros" BIGINT NOT NULL DEFAULT 100000000,
    "yesShares" BIGINT NOT NULL DEFAULT 0,
    "noShares" BIGINT NOT NULL DEFAULT 0,
    "yesPrice" DECIMAL(30,20) NOT NULL DEFAULT 0.5,
    "volumeMicros" BIGINT NOT NULL DEFAULT 0,
    "version" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "markets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "marketId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "yesShares" BIGINT NOT NULL DEFAULT 0,
    "noShares" BIGINT NOT NULL DEFAULT 0,
    "totalCostMicros" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "marketId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "side" "ContractSide" NOT NULL,
    "quantity" BIGINT NOT NULL,
    "costMicros" BIGINT NOT NULL,
    "yesPriceBefore" DECIMAL(30,20) NOT NULL,
    "yesPriceAfter" DECIMAL(30,20) NOT NULL,
    "marketVersion" BIGINT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "paymentTransferId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfers" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "fromWalletId" UUID NOT NULL,
    "toWalletId" UUID NOT NULL,
    "amountMicros" BIGINT NOT NULL,
    "kind" "TransferKind" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_events" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "marketId" UUID NOT NULL,
    "version" BIGINT NOT NULL,
    "kind" "MarketEventKind" NOT NULL,
    "occurredAt" TIMESTAMPTZ NOT NULL,
    "yesPrice" DECIMAL(30,20) NOT NULL,
    "tradeAmountMicros" BIGINT NOT NULL DEFAULT 0,
    "tradeId" UUID,
    "payload" JSONB NOT NULL,

    CONSTRAINT "market_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_deliveries" (
    "id" UUID NOT NULL,
    "marketEventId" UUID NOT NULL,
    "destination" TEXT NOT NULL DEFAULT 'TIGER',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" UUID,
    "leaseUntil" TIMESTAMPTZ,
    "deliveredAt" TIMESTAMPTZ,
    "lastError" TEXT,

    CONSTRAINT "outbox_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "marketId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "observedAt" TIMESTAMPTZ NOT NULL,
    "receivedAt" TIMESTAMPTZ NOT NULL,
    "isFinal" BOOLEAN NOT NULL,
    "normalizedData" JSONB NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "submittedByProfileId" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "marketId" UUID NOT NULL,
    "outcome" "SettlementOutcome" NOT NULL,
    "evidenceId" UUID NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "resolvedByProfileId" UUID,
    "resolverVersion" TEXT NOT NULL,
    "settledAt" TIMESTAMPTZ NOT NULL,
    "receipt" JSONB NOT NULL,
    "receiptHash" TEXT NOT NULL,
    "totalPayoutMicros" BIGINT NOT NULL,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "marketId" UUID NOT NULL,
    "settlementId" UUID NOT NULL,
    "positionId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "amountMicros" BIGINT NOT NULL,
    "originalCostMicros" BIGINT NOT NULL,
    "transferId" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demo_actions" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "sequence" BIGINT NOT NULL,
    "virtualAt" TIMESTAMPTZ NOT NULL,
    "actorProfileId" UUID NOT NULL,
    "actionType" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "resultReference" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chain_commitments" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "marketId" UUID NOT NULL,
    "settlementId" UUID,
    "kind" TEXT NOT NULL,
    "canonicalizationVersion" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'devnet',
    "signerPublicKey" TEXT NOT NULL,
    "transactionSignature" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMPTZ,
    "lastError" TEXT,

    CONSTRAINT "chain_commitments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "profiles_authUserId_key" ON "profiles"("authUserId");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_handle_key" ON "profiles"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "environments_key_key" ON "environments"("key");

-- CreateIndex
CREATE INDEX "wallets_profileId_idx" ON "wallets"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_environmentId_profileId_key" ON "wallets"("environmentId", "profileId");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_id_environmentId_key" ON "wallets"("id", "environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "markets_marketMakerWalletId_key" ON "markets"("marketMakerWalletId");

-- CreateIndex
CREATE INDEX "markets_environmentId_status_category_closesAt_idx" ON "markets"("environmentId", "status", "category", "closesAt");

-- CreateIndex
CREATE UNIQUE INDEX "markets_environmentId_slug_key" ON "markets"("environmentId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "markets_marketMakerWalletId_environmentId_key" ON "markets"("marketMakerWalletId", "environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "markets_id_environmentId_key" ON "markets"("id", "environmentId");

-- CreateIndex
CREATE INDEX "positions_walletId_environmentId_idx" ON "positions"("walletId", "environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "positions_marketId_walletId_key" ON "positions"("marketId", "walletId");

-- CreateIndex
CREATE UNIQUE INDEX "positions_id_environmentId_marketId_walletId_key" ON "positions"("id", "environmentId", "marketId", "walletId");

-- CreateIndex
CREATE UNIQUE INDEX "trades_paymentTransferId_key" ON "trades"("paymentTransferId");

-- CreateIndex
CREATE INDEX "trades_walletId_createdAt_idx" ON "trades"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "trades_marketId_marketVersion_idx" ON "trades"("marketId", "marketVersion");

-- CreateIndex
CREATE UNIQUE INDEX "trades_walletId_idempotencyKey_key" ON "trades"("walletId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "transfers_dedupeKey_key" ON "transfers"("dedupeKey");

-- CreateIndex
CREATE INDEX "transfers_fromWalletId_idx" ON "transfers"("fromWalletId");

-- CreateIndex
CREATE INDEX "transfers_toWalletId_idx" ON "transfers"("toWalletId");

-- CreateIndex
CREATE INDEX "market_events_environmentId_marketId_occurredAt_idx" ON "market_events"("environmentId", "marketId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "market_events_marketId_version_key" ON "market_events"("marketId", "version");

-- CreateIndex
CREATE INDEX "outbox_deliveries_status_nextAttemptAt_idx" ON "outbox_deliveries"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_deliveries_marketEventId_destination_key" ON "outbox_deliveries"("marketEventId", "destination");

-- CreateIndex
CREATE INDEX "evidence_marketId_idx" ON "evidence"("marketId");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_id_environmentId_marketId_key" ON "evidence"("id", "environmentId", "marketId");

-- CreateIndex
CREATE UNIQUE INDEX "settlements_marketId_key" ON "settlements"("marketId");

-- CreateIndex
CREATE INDEX "settlements_evidenceId_idx" ON "settlements"("evidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "settlements_id_environmentId_marketId_key" ON "settlements"("id", "environmentId", "marketId");

-- CreateIndex
CREATE UNIQUE INDEX "settlements_marketId_environmentId_key" ON "settlements"("marketId", "environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_positionId_key" ON "payouts"("positionId");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_transferId_key" ON "payouts"("transferId");

-- CreateIndex
CREATE INDEX "payouts_walletId_idx" ON "payouts"("walletId");

-- CreateIndex
CREATE INDEX "payouts_settlementId_idx" ON "payouts"("settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_positionId_environmentId_marketId_walletId_key" ON "payouts"("positionId", "environmentId", "marketId", "walletId");

-- CreateIndex
CREATE UNIQUE INDEX "demo_actions_environmentId_sequence_key" ON "demo_actions"("environmentId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "chain_commitments_marketId_kind_key" ON "chain_commitments"("marketId", "kind");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "markets" ADD CONSTRAINT "markets_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "markets" ADD CONSTRAINT "markets_marketMakerWalletId_environmentId_fkey" FOREIGN KEY ("marketMakerWalletId", "environmentId") REFERENCES "wallets"("id", "environmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_marketId_environmentId_fkey" FOREIGN KEY ("marketId", "environmentId") REFERENCES "markets"("id", "environmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_walletId_environmentId_fkey" FOREIGN KEY ("walletId", "environmentId") REFERENCES "wallets"("id", "environmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_marketId_environmentId_fkey" FOREIGN KEY ("marketId", "environmentId") REFERENCES "markets"("id", "environmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_walletId_environmentId_fkey" FOREIGN KEY ("walletId", "environmentId") REFERENCES "wallets"("id", "environmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_paymentTransferId_fkey" FOREIGN KEY ("paymentTransferId") REFERENCES "transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_fromWalletId_environmentId_fkey" FOREIGN KEY ("fromWalletId", "environmentId") REFERENCES "wallets"("id", "environmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_toWalletId_environmentId_fkey" FOREIGN KEY ("toWalletId", "environmentId") REFERENCES "wallets"("id", "environmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_events" ADD CONSTRAINT "market_events_marketId_environmentId_fkey" FOREIGN KEY ("marketId", "environmentId") REFERENCES "markets"("id", "environmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_deliveries" ADD CONSTRAINT "outbox_deliveries_marketEventId_fkey" FOREIGN KEY ("marketEventId") REFERENCES "market_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_marketId_environmentId_fkey" FOREIGN KEY ("marketId", "environmentId") REFERENCES "markets"("id", "environmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_marketId_environmentId_fkey" FOREIGN KEY ("marketId", "environmentId") REFERENCES "markets"("id", "environmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_evidenceId_environmentId_marketId_fkey" FOREIGN KEY ("evidenceId", "environmentId", "marketId") REFERENCES "evidence"("id", "environmentId", "marketId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_settlementId_environmentId_marketId_fkey" FOREIGN KEY ("settlementId", "environmentId", "marketId") REFERENCES "settlements"("id", "environmentId", "marketId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_positionId_environmentId_marketId_walletId_fkey" FOREIGN KEY ("positionId", "environmentId", "marketId", "walletId") REFERENCES "positions"("id", "environmentId", "marketId", "walletId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Application-owned tables only. Prisma is the sole migration owner.
ALTER TABLE profiles ADD CONSTRAINT human_identity CHECK ((kind='HUMAN' AND "authUserId" IS NOT NULL) OR (kind='BOT' AND "authUserId" IS NULL));
ALTER TABLE environments ADD CONSTRAINT environment_bounds CHECK ("initialSupplyMicros">0 AND "startingGrantMicros">0 AND speed BETWEEN 1 AND 10 AND "runState" IN ('PAUSED','RUNNING') AND (kind='LIVE' OR ("virtualNow" IS NOT NULL AND "simulatedStartAt" IS NOT NULL)));
ALTER TABLE wallets ADD CONSTRAINT wallet_bounds CHECK ("balanceMicros">=0 AND "openingBalanceMicros">=0 AND ((kind='USER')=("profileId" IS NOT NULL)) AND (kind='TREASURY' OR "openingBalanceMicros"=0));
CREATE UNIQUE INDEX one_treasury ON wallets("environmentId") WHERE kind='TREASURY';
CREATE UNIQUE INDEX one_grant ON transfers("toWalletId") WHERE kind='STARTING_GRANT';
ALTER TABLE markets ADD CONSTRAINT market_bounds CHECK ("liquidityBMicros">=1000000 AND "yesShares">=0 AND "noShares">=0 AND "yesShares"+"noShares"<=1000001000 AND "yesPrice" BETWEEN 0 AND 1 AND "volumeMicros">=0 AND version>=0 AND "closesAt">"opensAt");
ALTER TABLE positions ADD CONSTRAINT position_bounds CHECK ("yesShares">=0 AND "noShares">=0 AND "totalCostMicros">=0);
ALTER TABLE trades ADD CONSTRAINT trade_bounds CHECK (quantity BETWEEN 1 AND 1000 AND "costMicros">0 AND "yesPriceBefore" BETWEEN 0 AND 1 AND "yesPriceAfter" BETWEEN 0 AND 1);
ALTER TABLE transfers ADD CONSTRAINT transfer_bounds CHECK ("amountMicros">0 AND "fromWalletId"<>"toWalletId");
ALTER TABLE payouts ADD CONSTRAINT payout_bounds CHECK ("amountMicros">=0 AND "originalCostMicros">=0 AND (("amountMicros"=0)=("transferId" IS NULL)));
ALTER TABLE market_events ADD CONSTRAINT event_bounds CHECK (version>0 AND "tradeAmountMicros">=0 AND "yesPrice" BETWEEN 0 AND 1 AND ((kind='PRICE_CHANGED')=("tradeId" IS NOT NULL)) AND (kind='PRICE_CHANGED' OR "tradeAmountMicros"=0));
ALTER TABLE demo_actions ADD FOREIGN KEY ("environmentId") REFERENCES environments(id);
ALTER TABLE demo_actions ADD FOREIGN KEY ("actorProfileId") REFERENCES profiles(id);
ALTER TABLE chain_commitments ADD FOREIGN KEY ("marketId","environmentId") REFERENCES markets(id,"environmentId");
ALTER TABLE chain_commitments ADD FOREIGN KEY ("settlementId","environmentId","marketId") REFERENCES settlements(id,"environmentId","marketId");
ALTER TABLE evidence ADD FOREIGN KEY ("submittedByProfileId") REFERENCES profiles(id);
ALTER TABLE settlements ADD FOREIGN KEY ("resolvedByProfileId") REFERENCES profiles(id);
ALTER TABLE market_events ADD FOREIGN KEY ("tradeId") REFERENCES trades(id);
CREATE FUNCTION protect_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN RAISE EXCEPTION 'immutable audit row'; END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['trades','transfers','market_events','evidence','settlements','payouts','demo_actions'] LOOP EXECUTE format('CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protect_audit()',t); END LOOP; END $$;
CREATE FUNCTION protect_market() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.status<>'DRAFT' AND (NEW."resolutionRule",NEW."ruleHash",NEW."ruleVersion",NEW."liquidityBMicros",NEW."opensAt",NEW."closesAt",NEW.provider,NEW."externalEventId",NEW."sourceUrl",NEW.title,NEW."marketMakerWalletId",NEW."environmentId",NEW.category,NEW.context) IS DISTINCT FROM (OLD."resolutionRule",OLD."ruleHash",OLD."ruleVersion",OLD."liquidityBMicros",OLD."opensAt",OLD."closesAt",OLD.provider,OLD."externalEventId",OLD."sourceUrl",OLD.title,OLD."marketMakerWalletId",OLD."environmentId",OLD.category,OLD.context) THEN RAISE EXCEPTION 'frozen market rules'; END IF;
 IF NOT EXISTS(SELECT 1 FROM wallets WHERE id=NEW."marketMakerWalletId" AND kind='MARKET_MAKER' AND "environmentId"=NEW."environmentId") THEN RAISE EXCEPTION 'invalid maker wallet'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER market_protection BEFORE INSERT OR UPDATE ON markets FOR EACH ROW EXECUTE FUNCTION protect_market();
CREATE FUNCTION protect_environment() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
 IF (NEW.kind,NEW."initialSupplyMicros",NEW."startingGrantMicros",NEW.seed,NEW."scenarioVersion",NEW."simulatedStartAt") IS DISTINCT FROM (OLD.kind,OLD."initialSupplyMicros",OLD."startingGrantMicros",OLD.seed,OLD."scenarioVersion",OLD."simulatedStartAt") THEN RAISE EXCEPTION 'immutable environment'; END IF;RETURN NEW;END $$;
CREATE TRIGGER environment_protection BEFORE UPDATE ON environments FOR EACH ROW EXECUTE FUNCTION protect_environment();
CREATE FUNCTION protect_wallet() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
 IF (NEW."openingBalanceMicros",NEW.kind,NEW."environmentId",NEW."profileId") IS DISTINCT FROM (OLD."openingBalanceMicros",OLD.kind,OLD."environmentId",OLD."profileId") THEN RAISE EXCEPTION 'immutable wallet identity'; END IF;RETURN NEW;END $$;
CREATE TRIGGER wallet_protection BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION protect_wallet();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['profiles','environments','wallets','markets','positions','trades','transfers','market_events','outbox_deliveries','evidence','settlements','payouts','demo_actions','chain_commitments'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated',t); END IF;
 END LOOP;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN
 GRANT SELECT ON market_events TO anon,authenticated;
 EXECUTE 'CREATE POLICY public_events ON market_events FOR SELECT TO anon,authenticated USING (true)';
 END IF;
 IF EXISTS(SELECT FROM pg_publication WHERE pubname='supabase_realtime') THEN ALTER PUBLICATION supabase_realtime ADD TABLE market_events; END IF;
END $$;
-- All routines use invoker privileges; no browser mutation functions are exposed.
REVOKE EXECUTE ON FUNCTION protect_audit(),protect_market(),protect_environment(),protect_wallet() FROM PUBLIC;
