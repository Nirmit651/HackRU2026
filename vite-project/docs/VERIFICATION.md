# Verification record

Executed locally on October 10, 2026. These results describe the implemented local application, not hosted services. Commands run from `vite-project` using the ignored local `.env`.

| Check                              | Observed result                                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prisma migrations                  | Both versioned migrations applied to isolated PostgreSQL 18.6; generated Prisma 7 client                                                                                                        |
| `npm run lint`                     | Passed                                                                                                                                                                                          |
| `npm run build`                    | TypeScript check and Vite production build passed                                                                                                                                               |
| `npm test`                         | 9 tests passed: LMSR/rounding/reserves, event recovery, provider fixtures and memo verification                                                                                                 |
| `npm run test:db`                  | 16 tests passed against real PostgreSQL: ledger/concurrency/rollback, grants, settlement, replay, environment/auth boundaries and cutoff after lock acquisition                                 |
| `npm run test:outbox`              | 2 tests passed with a separate plain PostgreSQL analytical database: duplicate/retry delivery, ordering, contiguous watermark and merged history                                                |
| `npm run test:e2e`                 | Chromium flow passed with two client pages: demo entry, buy, second-client quote recovery, holdings, settlement, personal receipt and leaderboard; no page errors or mobile horizontal overflow |
| `npx tsx scripts/verify-worker.ts` | Separately started worker settled all 6 demo markets; 11 accepted actions; replay matched and both ledgers reconciled                                                                           |
| `npm run benchmark`                | 1,000/1,000 committed, 0 rejected; 236.1 trades/s; p50 82.2 ms; p95 92.4 ms; ledger reconciled                                                                                                  |

Run worker verification with `npm run worker` in another terminal. Keep that worker stopped during the database/outbox test suites so it cannot advance their isolated demo clocks or claim their outbox fixtures. Run the browser test with API and Vite running and development demo auth enabled. The outbox tests require an explicitly separate local `TIGER_DATABASE_URL`; they do not exercise TimescaleDB.

Raw reports: [trading benchmark](benchmark.json), [independent worker and replay](worker-verification.json). Workload/runtime/hardware details and commands are in the [README](../README.md#verification-and-performance). Screenshots: [desktop](browser-desktop.png), [market detail](browser-detail.png), [mobile](browser-mobile.png), [leaderboard](browser-leaderboard.png).

## Credential-dependent checks still outstanding

- **Hosted Supabase:** project-scoped Codex MCP configuration and OAuth login succeeded. The preexisting plugin account lacked access to the supplied project; newly configured tools were not exposed in this session. No hosted database URL or publishable key was supplied. Hosted migrations, real email authentication, Realtime transport, anonymous RLS enforcement and Supabase advisors remain unverified. Local browser tests use the explicitly labeled polling fallback and ephemeral demo auth.
- **Tiger Cloud:** connected account listed no services; no runtime URL was provided. No Timescale hypertable/continuous aggregate migration or Tiger performance run occurred. Configure the URL, run `tiger:migrate`, worker export and `tiger:benchmark`; measure real export lag. No Tiger speedup or latency is claimed.
- **Providers and map:** football/basketball normalization uses validated fixtures in unit tests. Live authenticated providers, the teammate bus feed, normalized weather evidence feed and external map style require configuration and end-to-end verification. Missing feeds stay unavailable/pending.
- **Deployment:** none published. No competition entry submitted; intended targets remain Lucera and Tiger Data.

Known non-failing diagnostics: Vite reports a large lazy-loaded Mapbox chunk. Prisma/pg reports a concurrent-query deprecation warning; pg is pinned below 9. The local PostgreSQL fixture uses a loopback-only development owner account; production runtime privileges must use the explicit role setup in the README.
