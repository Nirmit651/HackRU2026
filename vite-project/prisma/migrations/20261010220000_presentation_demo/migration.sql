ALTER TYPE "Category" ADD VALUE IF NOT EXISTS 'PRESENTATION_DEMO';

CREATE TABLE "presentation_demo_runs" (
  "id" UUID NOT NULL,
  "marketId" UUID NOT NULL,
  "environmentId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'READY',
  "seed" INTEGER NOT NULL,
  "startedAt" TIMESTAMPTZ,
  "deadlineAt" TIMESTAMPTZ,
  "finishedAt" TIMESTAMPTZ,
  "outcome" "SettlementOutcome",
  "workflowRunId" TEXT,
  "botCount" INTEGER NOT NULL DEFAULT 12,
  "botTradeCount" INTEGER NOT NULL DEFAULT 0,
  "botVolumeMicros" BIGINT NOT NULL DEFAULT 0,
  "lastBotActivityAt" TIMESTAMPTZ,
  "createdByProfileId" UUID,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "presentation_demo_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "presentation_demo_runs_marketId_key" UNIQUE ("marketId"),
  CONSTRAINT "presentation_demo_runs_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT,
  CONSTRAINT "presentation_demo_runs_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments"("id") ON DELETE RESTRICT
);
CREATE INDEX "presentation_demo_runs_environmentId_status_createdAt_idx" ON "presentation_demo_runs"("environmentId", "status", "createdAt");

CREATE TABLE "simulation_bot_states" (
  "id" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "botProfileId" UUID NOT NULL,
  "marketId" UUID NOT NULL,
  "strategy" TEXT NOT NULL,
  "belief" DECIMAL(8,6) NOT NULL DEFAULT 0.5,
  "currentlyHeldSide" "ContractSide",
  "spentMicros" BIGINT NOT NULL DEFAULT 0,
  "proceedsMicros" BIGINT NOT NULL DEFAULT 0,
  "tradeCount" INTEGER NOT NULL DEFAULT 0,
  "lastDecisionAt" TIMESTAMPTZ,
  "nextDecisionAt" TIMESTAMPTZ,
  "stateJson" JSONB NOT NULL DEFAULT '{}',
  "version" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "simulation_bot_states_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "simulation_bot_states_runId_botProfileId_key" UNIQUE ("runId", "botProfileId"),
  CONSTRAINT "simulation_bot_states_runId_fkey" FOREIGN KEY ("runId") REFERENCES "presentation_demo_runs"("id") ON DELETE RESTRICT,
  CONSTRAINT "simulation_bot_states_botProfileId_fkey" FOREIGN KEY ("botProfileId") REFERENCES "profiles"("id") ON DELETE RESTRICT
);
CREATE INDEX "simulation_bot_states_marketId_nextDecisionAt_idx" ON "simulation_bot_states"("marketId", "nextDecisionAt");

CREATE TABLE "simulation_decisions" (
  "id" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "botProfileId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "elapsedMilliseconds" INTEGER NOT NULL,
  "timerSignal" DECIMAL(8,6) NOT NULL,
  "priceBefore" DECIMAL(8,6) NOT NULL,
  "heldSideBefore" "ContractSide",
  "desiredSide" "ContractSide",
  "action" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 0,
  "sellTradeId" UUID,
  "buyTradeId" UUID,
  "skipReason" TEXT,
  "idempotencyKeys" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ,
  CONSTRAINT "simulation_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "simulation_decisions_runId_botProfileId_sequence_key" UNIQUE ("runId", "botProfileId", "sequence"),
  CONSTRAINT "simulation_decisions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "presentation_demo_runs"("id") ON DELETE RESTRICT,
  CONSTRAINT "simulation_decisions_botProfileId_fkey" FOREIGN KEY ("botProfileId") REFERENCES "profiles"("id") ON DELETE RESTRICT
);
CREATE INDEX "simulation_decisions_runId_createdAt_idx" ON "simulation_decisions"("runId", "createdAt");

ALTER TABLE "presentation_demo_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "simulation_bot_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "simulation_decisions" ENABLE ROW LEVEL SECURITY;
