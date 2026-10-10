# HTTP API

All routes are under `/api`. Money/share/version BIGINTs are decimal strings. Mutation bodies are bounded to 32 KiB. Errors have `{error:{code,details?}}`. Auth uses a verified Supabase bearer token, or loopback-only development demo token. Private endpoints derive wallets from identity and environment, never request wallet IDs. Admin role comes from server-controlled app metadata.

| Method / path                    | Inputs / behavior                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| GET `/config`                    | Browser-safe Supabase URL/publishable key, map style and local-demo flag only                                                 |
| GET `/environments`              | Latest 50 environment display records                                                                                         |
| GET `/markets`                   | Required environmentId; optional category, status, search (100 chars), UUID cursor, limit 1–50; returns items/nextCursor      |
| GET `/markets/:id`               | Authoritative quote, version, frozen rules and asOf                                                                           |
| GET `/markets/:id/history`       | range 1H/1D/1W/ALL (max 31 days); source, interval, bounds, throughVersion, exportedThroughVersion, truncated                 |
| GET `/markets/:id/events`        | afterVersion decimal string; contiguous durable events, up to 500/page, hasMore                                               |
| POST `/markets/:id/quote`        | environmentId, YES/NO side, quantity 1–1,000; estimate, payout and net profit, never a guaranteed execution                   |
| POST `/markets/:id/trades`       | Auth; environmentId, side, quantity, maxCostMicros, idempotencyKey (8–100 chars); path marketId authoritative                 |
| POST `/runner/trades`            | Server runner bearer token; configured DEMO environment and BOT identity only; same atomic trading service                    |
| GET `/me`                        | Auth; own display name/campus/admin flag                                                                                      |
| PATCH `/me`                      | Auth; displayName/campus only                                                                                                 |
| GET `/me/wallet`                 | Auth; environmentId; creates idempotent treasury-funded starting wallet if absent                                             |
| GET `/me/positions`              | Auth; environmentId; up to 100 positions and 100 recent trades                                                                |
| GET `/leaderboard`               | environmentId, optional campus; 50 human USER wallets, cash balance descending with profile UUID tie-break; no auth IDs/email |
| GET `/markets/:id/receipt`       | Public receipt/hash; optional authenticated ownership-gated personal portion                                                  |
| GET `/markets/:id/verify`        | Optional kind RULES/SETTLEMENT; verifies configured Devnet publication                                                        |
| GET `/markets/:id/bus`           | Typed adapter snapshot or unavailable null                                                                                    |
| POST `/admin/markets`            | Admin; validated funded draft; schema in server/markets.ts                                                                    |
| POST `/admin/markets/:id/status` | Admin; OPEN/PAUSED/CLOSED, validated lifecycle                                                                                |
| POST `/admin/markets/:id/settle` | Admin; normalized final ProviderEvidence; frozen rule determines outcome                                                      |
| GET `/admin/health`              | Admin; Tiger configured/pending/failed/oldest pending event                                                                   |
| GET `/admin/reconcile`           | Admin; environmentId; ledger reconciliation                                                                                   |
| POST `/admin/demo`               | Admin; seed, creates new isolated run                                                                                         |
| POST `/admin/demo/:id`           | Admin; runState RUNNING/PAUSED, speed integer 1–10; DEMO only                                                                 |
| POST `/demo/session`             | Development loopback only; displayName; ephemeral signed demo token                                                           |

`shared/contracts.ts` defines BuyInput, Rule, ProviderEvidence, BusSnapshot, PublicMarket, PublicEvent and History. `shared/templates.ts` generates reviewable draft templates. Times are UTC ISO strings, rendered in America/New_York with date and timezone.

Key errors: UNAUTHORIZED, FORBIDDEN, INVALID_INPUT, MARKET_CLOSED, MARKET_NOT_CLOSED, INSUFFICIENT_FUNDS, SLIPPAGE_EXCEEDED, IDEMPOTENCY_CONFLICT, SETTLEMENT_CONFLICT, EVIDENCE_MISMATCH, AWAITING_EVIDENCE, ORIGIN_REJECTED, RATE_LIMITED, TEMPORARILY_UNAVAILABLE. External dependency errors are sanitized.

The UI/API are same-origin. Bearer tokens are not automatically attached by browsers on cross-site requests; supplied Origin is checked for mutations. No cookie mutation auth is used. Local rate limit: 180 mutation requests/IP/minute; provider/worker engine benchmarks intentionally bypass HTTP transport and do not claim API-level throughput.
