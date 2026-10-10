from __future__ import annotations

import argparse
from dataclasses import asdict
import json
import sys

from dotenv import load_dotenv

from .config import ConfigurationError, Settings
from .normalize import normalize_snapshot
from .persistence import PostgresPersistence
from .source import RubusHttpSource, SourceFetchError


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Fetch and ingest one RUBus vehicle snapshot")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="fetch and validate live data without opening a database connection",
    )
    return parser


def _print(value: dict[str, object]) -> None:
    print(json.dumps(value, default=str, sort_keys=True))


def main() -> int:
    args = _parser().parse_args()
    load_dotenv()
    try:
        settings = Settings.from_environment(require_database=not args.dry_run)
    except ConfigurationError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2

    source = RubusHttpSource(
        settings.rubus_bus_url,
        timeout_seconds=settings.http_timeout_seconds,
        max_response_bytes=settings.max_response_bytes,
    )

    if args.dry_run:
        try:
            fetched = source.fetch()
        except SourceFetchError as exc:
            _print({"status": "fetch_failed", "error_code": exc.code, "message": str(exc)})
            return 1
        normalized = normalize_snapshot(fetched, stale_after_seconds=settings.stale_after_seconds)
        _print(
            {
                "status": "invalid" if normalized.fatal_issue else (
                    "valid" if normalized.is_complete else "partial"
                ),
                "http_status": fetched.http_status,
                "retrieved_at": fetched.retrieved_at,
                "payload_sha256": fetched.sha256,
                "records_received": normalized.received_count,
                "records_valid": len(normalized.observations),
                "records_invalid": normalized.invalid_count,
                "source_time_status": normalized.source_time_status,
                "issues": [issue.as_dict() for issue in normalized.issues],
            }
        )
        return 0 if normalized.fatal_issue is None else 1

    assert settings.database_url is not None
    persistence = PostgresPersistence(settings.database_url)
    try:
        run_id = persistence.start_run(settings.rubus_bus_url)
    except Exception as exc:
        print(f"could not record collection attempt: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    try:
        fetched = source.fetch()
    except SourceFetchError as exc:
        persistence.record_fetch_failure(run_id, exc)
        _print({"run_id": run_id, "status": "failed", "error_code": exc.code})
        return 1

    normalized = normalize_snapshot(fetched, stale_after_seconds=settings.stale_after_seconds)
    try:
        persisted = persistence.persist(run_id, fetched, normalized)
    except Exception as exc:
        try:
            persistence.record_unexpected_failure(run_id, exc)
        except Exception:
            pass
        print(f"persistence failed for run {run_id}: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    _print(asdict(persisted))
    return 0 if persisted.status == "succeeded" else 1


if __name__ == "__main__":
    raise SystemExit(main())

