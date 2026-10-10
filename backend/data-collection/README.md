# Rutgers bus collector

This package performs one RUBus HTTP snapshot ingestion. It does not schedule
collection or implement arrivals, ETAs, settlement, markets, or frontend APIs.

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
