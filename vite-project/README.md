# Scarlet Exchange

Bus-arrival, Rutgers football, and Rutgers men's basketball markets are implemented in `server/automation`. See [automation setup, policies, credentials, commands and verification](docs/AUTOMATION.md). They reuse the existing funding, trading, settlement and event services. Generators start disabled until configured in Admin.

A Rutgers campus prediction-market demo for HackRU 2026. Students spend **play $R**, buy YES/NO shares, receive settlement receipts, and compete by **cash balance**. No purchase, cash-out, secondary selling, or official Rutgers affiliation.

The existing repository was a Vite React starter with no Supabase/Tiger application code. This implementation preserves Vite/npm and adds a TypeScript Express API/worker and Prisma 7 PostgreSQL engine.

## Local setup

Requirements: Node 22+, npm and PostgreSQL 15+. Verified with Node 26.4, Postgres.app 18.6, and port 55432.

```sh
cd vite-project
npm ci
cp .env.example .env
# For offline demo, leave SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY empty.
# Set DATABASE_URL and DIRECT_DATABASE_URL to your local PostgreSQL database.
npm run db:generate
npm run db:migrate
npm run demo:new
npm run api
```

In two additional terminals, from `vite-project`:

```sh
npm run dev
npm run worker
```

Open http://localhost:5173, select a DEMO run, and **Join the market**. The local development sign-in creates a separate $R 1,000 wallet. It binds the API to loopback, is disabled in production, and cannot operate LIVE accounts. Restarting the API invalidates local tokens; sign in again. Root npm scripts forward common commands to the app directory.

After the first-time setup, the root shortcut `npm run demo` runs `db:generate`, applies migrations, creates a fresh DEMO run, and starts the API, Vite frontend, and worker together. Open http://localhost:5173 and press Ctrl+C to stop the demo. PostgreSQL must still be running locally.

Example isolated PostgreSQL initialization (use a fresh directory/port if these exist):

```sh
initdb -D /tmp/hackru-postgres -A trust -U hackru --encoding=UTF8 --no-locale
pg_ctl -D /tmp/hackru-postgres -l /tmp/hackru-postgres.log \
  -o '-p 55432 -h 127.0.0.1 -k /tmp -c max_connections=60 -c shared_buffers=128MB' start
createdb -h 127.0.0.1 -p 55432 -U hackru hackru
# When finished:
pg_ctl -D /tmp/hackru-postgres stop
```

Never reset a shared database. Local tests insert isolated environments and preserve audit rows.

## Supabase setup

Target project: `uyjnsuazcxwzoxauhmpm`. Its project-scoped Codex MCP was added and OAuth reported successful login. The preexisting plugin connection lacked project access; the new tools were not exposed in the active session. **No hosted migrations, hosted authentication tests, or hosted Realtime tests are claimed.** No hosted database was modified.

1. Set `SUPABASE_URL` and the browser-safe publishable key. Never expose a service key or database URL to the browser.
2. Set `DIRECT_DATABASE_URL` to a migration-owner connection and `DATABASE_URL` to the backend runtime connection, using TLS verification. Do not disable certificate checks.
3. Review and run `npm run db:migrate`. Prisma owns application tables only. Version-controlled SQL preserves RLS, constraints, grants and `market_events` publication membership; it does not manage auth/storage/realtime schemas.
4. Apply `prisma/runtime-role.sql` once as migration owner. Create a login/password out of band, grant it `scarlet_runtime`, and use it for the runtime URL. This backend-only role has explicit policies and grants, without DELETE or audit UPDATE. Application authorization checks the verified user on every private request.
5. Enable email sign-in; allow redirects to the web origin. Set `APP_ORIGIN` exactly, `LOCAL_DEMO_AUTH=false`, and `NODE_ENV=production`. Set admins through server-controlled `app_metadata.role=admin`, never user metadata.
6. Run `npm run live:new -- <unique-key>` to create a finite LIVE treasury. Admin includes six draft templates. Replace placeholders and verify the source, event/station/trip IDs, cutoff, window, units, finality and VOID policy before opening.
7. Run hosted Supabase security/performance advisors and confirm browser denial for private tables and successful public-event subscriptions. These hosted checks remain outstanding.

MCP is a development connection; runtime still needs its own URLs/keys. `codex mcp get supabase` verified configuration. `/mcp` is an interactive Codex command, not a shell command. Reload Codex if newly added tools are unavailable.

## Demo walkthrough

## One-minute presentation demo

The featured **Presentation Demo** is a real market, not a visual simulation:
its bot orders call the same LMSR buy/sell engine, wallet ledger, position
invariant, event stream, chart and settlement service as participant orders.

1. Click **Become admin** and enter `admin` (the server-only
   `DEMO_ADMIN_PASSWORD`; change it outside the repository for any public use).
2. Click **Create presentation demo**, open the resulting card, then choose
   **Start presentation market**. The server stores one `startedAt` and a
   `deadlineAt` exactly 60 seconds later.
3. Use **Finish presentation** before the deadline to settle NO. At the exact
   deadline—or after a delayed worker wake—the stored deadline settles YES.
   The browser timer is display-only and reconstructs from those server values.
4. Bot side changes sell their complete current side through `sell()` before
   a separate idempotent `buy()` call. They never directly edit positions,
   balances, price, volume or chart history.

`server/worker.ts` wakes database-backed presentation runs every second during
local development. In production, invoke `POST /api/presentation/tick` from a
durable scheduler with `PRESENTATION_RUNNER_TOKEN`; it is idempotent and
derives settlement from persisted timestamps. The existing `AutomationJob`
and run records are the durable orchestration source of truth, avoiding an
in-memory serverless timer. Configure the same secrets in Vercel before deploy.

1. Join in one browser; open the same environment/market in another.
2. Admin → **Start**, optionally 2×/5×/10×. The worker must be running.
3. Buy ten YES shares. Cash and holdings update, and the second client recovers the quote/chart update. Twenty labeled synthetic bots use the same engine.
4. At 120 virtual seconds trading closes; at 150 seconds synthetic final evidence settles all six categories. Pause holds virtual time.
5. Open and download a receipt, then check portfolio and cash leaderboard. Bots, treasury and market-maker wallets are excluded from human rankings.
6. **New run** inserts a fresh environment. It never deletes prior or LIVE data.

```sh
npm run demo:export -- <environment-uuid>
npm run demo:replay -- <environment-uuid>
# Optional: with worker stopped, create a paused run with executed bot history.
npm run demo:showcase
# With worker running, verify all six markets settle and replay matches.
npm run demo:verify-worker
```

The export includes seed, fixture version, initial clock, ordered accepted inputs, expected market totals and reconciliation. Replay includes recorded human purchases and remaps market/actor IDs. Rejected inputs do not affect economic state and are not logged. A seed alone cannot reproduce different human actions. Sequential replay is separate from concurrent benchmarking. History comes only from executed trades/events.

## Tiger analytics

Tiger MCP was exercised and returned **no services**. `TIGER_DATABASE_URL` was not supplied. The normal Tiger path is implemented, but hosted Timescale migrations, aggregate behavior and performance remain unverified.

```sh
# Configure the separate server-only Tiger TLS connection first.
npm run tiger:migrate
npm run worker
npm run tiger:benchmark
```

`tiger/001_history.sql` creates a time-partitioned hypertable, `(event_time,event_id)` dedupe key, history index and one-minute OHLC/trade-count/volume continuous aggregate. First/last price orders by unique market version; only trade events count as trades. Real-time aggregation and the refresh policy are explicit.

The exporter uses expiring leases, backoff, sanitized errors and a single-worker lock. It preserves original IDs/timestamps and acknowledges only after an idempotent insert. Earlier pending market events block later ones. The exported watermark is contiguous, not a maximum. History reads Tiger through it and merges the committed PostgreSQL tail; outages return an explicitly labeled `SUPABASE_FALLBACK`. Keep the full authoritative ledger/event log. Admin exposes pending/failed counts and oldest pending event time.

Chart history uses raw events; the minute aggregate is used by the analytical benchmark and available for future long-range rendering. Queries cap history at 10,000 events and report `truncated`. A changed Tiger destination requires rebuilding its copy and reviewing delivery-state reset; existing acknowledgments refer to the configured destination.

For development MCP on another machine:

```sh
brew install --cask timescale/tap/tiger-cli
tiger auth login
tiger mcp install codex
# or tiger mcp install cursor
```

Restart the coding assistant. The hosted docs MCP supplies documentation; CLI MCP supplies account/database access. A working setup was not reinstalled here.

## Providers and bus boundary

See [BUS_ADAPTER.md](docs/BUS_ADAPTER.md). The teammate owns ingestion. `BUS_ADAPTER_URL`/token supplies display snapshots; `EVIDENCE_ADAPTER_URL`/token supplies normalized final observations. Neither fetches a browser-supplied URL. Missing feeds show unavailable; LIVE feeds reject simulated data. Mapbox loads only for bus markets. Set the public `MAPBOX_KEY` for the basemap; without it, the UI shows an explicit unavailable state.

CFBD football and CBBD basketball adapters validate finality, scores, Rutgers participation, game IDs and cutoff before play. CBBD 2027 denotes 2026–27. No broader varsity coverage is implied. The adapters were tested using labeled fixtures; authenticated live requests were not made. The used schemas do not supply a verified finish timestamp, so `observedAt` means the adapter observed final status at fetch time. Frozen sports windows must include that observation.

Bus settlement uses the normalized boundary. An outage is never evidence of NO. Missing results stay pending until evidence invokes the frozen VOID policy.

### Rutgers TripShot live bus market

`server/tripshot.ts` is the server-only provider for Rutgers' TripShot static GTFS archive and GTFS-Realtime TripUpdates/VehiclePositions feeds. It caches static GTFS for 24 hours, refreshes live feeds no more than every 15 seconds per process, enforces 8-second fetch timeouts and marks feeds stale after 45 seconds. It finds all College Avenue Student Center platforms by normalized `stops.txt` names, not a guessed ID. The browser receives only normalized map data from `/api/markets/:id/bus`; it never chooses or fetches an upstream URL.

The admin action **Create next College Ave dwell market** (`POST /api/bus/showcase`) refuses to create a market without a fresh next-arrival prediction. It freezes the TripShot trip/route/vehicle (when assigned), stop platform, feed timestamp, and five-minute dwell rules. Its outcome is observed dwell only: it does not make any claim about driver intent.

Settlement-grade observations must be written by a persistent collector to `bus_observations` every 10–20 seconds, then the supervised worker (`npm run worker`) evaluates frozen markets. Browser map polling is display-only evidence. Vercel Cron is unsuitable for continuous five-minute dwell coverage at ordinary plan frequencies; use a persistent worker/scheduled container instead. Run `npm run tripshot:smoke` after deployment to validate upstream freshness.

## Verification and performance

```sh
npm run build
npm run lint
npm test
npm run test:db
# API/Vite running with local demo auth:
npx playwright install chromium
npm run test:e2e
npm run benchmark
# Separate local analytics database, NOT a hosted Timescale test:
createdb -h 127.0.0.1 -p 55432 -U hackru hackru_analytics_test
TIGER_DATABASE_URL=postgresql://hackru@127.0.0.1:55432/hackru_analytics_test npm run test:outbox
```

Tests cover real transactions, concurrent grants/spending/retries/settlement, post-close retry, rollback, runner/environment restrictions, YES/NO/VOID payouts, deterministic replay, recovery gaps, auth/origin denial, worker pause and outbox crash/retry/watermark behavior. The browser flow covers two clients from login through buy, live quote recovery, settlement, receipt and leaderboard, plus mobile overflow and browser errors. Locally it exercises polling fallback, not hosted Realtime.

[benchmark.json](docs/benchmark.json) records an actual run: 20 clients, 1,000 attempts, 1,000 accepted, **236.1 trades/s**, **p50 82.2 ms**, **p95 92.4 ms**, 4.24 seconds after 20 warmup buys. Node 26.4, PostgreSQL 18.6, Apple M4 Max (14 logical CPUs), 36 GiB host RAM; PostgreSQL 128 MB shared buffers/60 connections. Shared host, no CPU quota. Six markets and frozen DEMO clock; provider/network calls excluded. The environment lock intentionally serializes deterministic demo accounting and is the main contention point. This is not a hosted/LIVE throughput claim. Reconciliation passed with exactly $R 1,000,000 supply. An initial invalid-key benchmark was corrected before this recorded run.

`tiger:benchmark` inserts an isolated disclosed 100,000-row synthetic analytics dataset, refreshes the aggregate, warms queries and reports 20-run history/aggregate p50/p95. It has **not run against Tiger**; no Tiger latency, exporter-lag number, compression gain or speedup is claimed. Simulated event timestamps are not wall-clock lag measurements.

## Deployment and limitations

Build and serve `dist` behind HTTPS, routing `/api` to the Node process. Start `npm run api` with production config and a separately supervised `npm run worker`. Apply migrations first. Workers finish current work and disconnect on SIGINT/SIGTERM; do not run them inside serverless requests. Review rollback as a forward migration and retain audit history.

Limits: per-process in-memory rate limits (use a shared limiter before scaling), bounded list/history/portfolio pages, buy-and-hold only, fixed synthetic demo fixtures, no arbitrary sports coverage, raw chart events rather than aggregate ranges, and a large lazy-loaded Mapbox bundle. Prisma/pg emits a concurrent-query deprecation warning during transaction batches; checks pass and pg is pinned below 9.

Team-built: ledger, LMSR, auth boundaries, frozen rules/evidence, settlement/receipts, recovery, exporter, adapters, demo/replay, UI and verification scripts. Third-party: React/Vite, Express, Supabase, Prisma/pg, Decimal.js, Zod, Tiger/TimescaleDB, TradingView Lightweight Charts, Mapbox GL JS, Lucide, Vitest and Playwright. No LLM API is required. Existing `.agents` and `skills-lock.json` were preserved.

More: [architecture](docs/ARCHITECTURE.md), [API](docs/API.md), [verification status](docs/VERIFICATION.md).

## GitHub Pages hosting

GitHub Pages can host the frontend, but not this project's Express API, PostgreSQL database, or worker. Follow [`docs/DEPLOY_GITHUB_PAGES.md`](../docs/DEPLOY_GITHUB_PAGES.md) to deploy the API/worker separately, configure the `API_ORIGIN` repository variable, enable Pages, and configure Supabase email-login redirects.

## References checked

[Supabase Prisma](https://supabase.com/docs/guides/database/prisma), [Realtime](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes), [explicit Data API grants](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically), [Prisma 7](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7), [Tiger indexes](https://www.tigerdata.com/docs/build/performance-optimization/hypertables-and-unique-indexes), [Tiger aggregates](https://www.tigerdata.com/docs/learn/continuous-aggregates), [Lightweight Charts](https://tradingview.github.io/lightweight-charts/docs), [Mapbox GL JS](https://docs.mapbox.com/mapbox-gl-js/guides/get-started/), [CFBD games](https://apinext.collegefootballdata.com/api/games), [CBBD games](https://api.collegebasketballdata.com/games).

The application uses play money only and is not affiliated with Rutgers University.
