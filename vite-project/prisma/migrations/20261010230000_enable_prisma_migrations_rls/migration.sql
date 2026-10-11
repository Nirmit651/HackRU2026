-- Prisma's migration ledger is in the exposed public schema. It is never read
-- by the browser, so deny direct Data API access while server-side Prisma
-- connections continue to manage migrations.
ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
