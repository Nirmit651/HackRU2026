# Rutgers bus collector

This package collects RUBus HTTP snapshots. It does not implement arrivals,
ETAs, settlement, markets, or frontend APIs; prediction-market work is outside
this phase.

## Setup

From `backend/data-collection`:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
cp .env.example .env
```

Fill `SUPABASE_DB_URL` in `.env` using the existing project's **Connect**
dialog. Use a backend database credential and keep `sslmode=require`. The
collector rejects connection strings that do not contain project reference
`uyjnsuazcxwzoxauhmpm`.

## One fetch

Fetch and validate without database access:

```bash
python -m rutgers_bus_collector.cli --dry-run
```

Fetch and persist one attempt:

```bash
python -m rutgers_bus_collector.cli
```

Collect continuously (the default interval is 15 seconds):

```bash
python -m rutgers_bus_collector.cli --watch --interval 15
```

Continuously fetch and validate without database access:

```bash
python -m rutgers_bus_collector.cli --watch --dry-run --interval 15
```

`--interval` accepts whole seconds from 5 through 300. Watch attempts are
sequential: after a successful attempt the collector waits that interval; after
each consecutive failure it waits `min(120, interval * 2^(failures - 1))`.
The failure count resets after success. Ctrl+C and SIGTERM stop promptly while
waiting, and let an in-progress attempt finish before exiting. Each attempt
writes one compact JSON summary to standard output.

This phase assumes a single collector instance. There is no distributed lock,
so do not run multiple instances against the same database. `demo.rubus.live`
is the configured demonstration endpoint and must not automatically be treated
as an authoritative live Rutgers source.

The collector first commits a `running` collection attempt. The raw snapshot,
valid normalized observations, route verification timestamps, and terminal run
status are then written in one transaction. A failed transaction is recorded as
failed, so partial persistence cannot appear successful.

Snapshot evidence retains only verified bus fields (`name`, coordinates, route,
capacity/occupancy, riders, rotation, and `last_updated`). The SHA-256 digest is
computed over the original response, while unexpected fields are not persisted.

`bus_latest` is not written directly. The database trigger only advances it for
valid observations with a newer effective observation time.

## Deduplication limitation

RUBus currently provides no stable observation ID. Position history therefore
deduplicates on source system, vehicle, observation kind, and source timestamp.
When `last_updated` is absent, retrieval time is explicitly recorded as the
ordering basis; replaying the same timestamp-less payload at a different time
cannot be proven to be a duplicate.

Run tests with:

```bash
python -m unittest discover -s tests
```
