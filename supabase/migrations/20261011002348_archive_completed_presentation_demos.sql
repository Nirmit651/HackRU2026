CREATE TABLE "market_archives" (
  "marketId" UUID NOT NULL,
  "archivedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason" TEXT NOT NULL,
  CONSTRAINT "market_archives_pkey" PRIMARY KEY ("marketId"),
  CONSTRAINT "market_archives_marketId_fkey"
    FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

ALTER TABLE "market_archives" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "market_archives" FROM anon, authenticated;
