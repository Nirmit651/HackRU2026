from __future__ import annotations

import argparse
from dataclasses import asdict
from datetime import datetime, timezone
import json
import signal
import sys
import threading
from typing import Callable

from dotenv import load_dotenv

from .config import ConfigurationError, Settings
from .normalize import normalize_snapshot
from .persistence import PostgresPersistence
from .source import RubusHttpSource, SourceFetchError


def _interval(value: str) -> int:
    try:
        seconds = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("interval must be an integer") from exc
    if not 5 <= seconds <= 300:
        raise argparse.ArgumentTypeError("interval must be between 5 and 300 seconds")
    return seconds


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Fetch and ingest RUBus vehicle snapshots")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="fetch and validate live data without opening a database connection",
    )
    parser.add_argument("--watch", action="store_true", help="repeat collection until stopped")
    parser.add_argument(
        "--interval",
        type=_interval,
        default=15,
        help="seconds between successful attempts (5-300, default: 15)",
    )
    return parser


def _print(value: dict[str, object]) -> None:
    print(json.dumps(value, default=str, sort_keys=True))


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def run_attempt(
    settings: Settings,
    source: RubusHttpSource,
    persistence: PostgresPersistence | None,
    attempt_number: int,
) -> tuple[bool, dict[str, object]]:
    """Fetch, validate, and optionally persist exactly one snapshot."""
    summary: dict[str, object] = {"attempt": attempt_number, "started_at": _timestamp()}
    run_id: object | None = None
    if persistence is not None:
        try:
            run_id = persistence.start_run(settings.rubus_bus_url)
            summary["run_id"] = run_id
        except Exception:
            summary.update(status="failed", error_code="persistence_error", finished_at=_timestamp())
            return False, summary

    try:
        fetched = source.fetch()
    except SourceFetchError as exc:
        if persistence is not None and run_id is not None:
            try:
                persistence.record_fetch_failure(run_id, exc)
            except Exception:
                pass
        summary.update(
            status="fetch_failed", error_code=exc.code, http_status=exc.http_status,
            finished_at=_timestamp(),
        )
        return False, summary

    normalized = normalize_snapshot(fetched, stale_after_seconds=settings.stale_after_seconds)
    summary.update(
        http_status=fetched.http_status,
        retrieved_at=fetched.retrieved_at,
        records_received=normalized.received_count,
        records_valid=len(normalized.observations),
        records_invalid=normalized.invalid_count,
        source_time_status=normalized.source_time_status,
        source_measured_at=normalized.source_measured_at,
    )
    if normalized.issues:
        summary["error_code"] = normalized.issues[0].code
    if persistence is None:
        status = "invalid" if normalized.fatal_issue else ("valid" if normalized.is_complete else "partial")
        summary.update(status=status, error_code=normalized.issues[0].code if normalized.issues else None)
        summary["finished_at"] = _timestamp()
        return normalized.fatal_issue is None and normalized.is_complete, summary

    assert run_id is not None
    try:
        persisted = persistence.persist(run_id, fetched, normalized)
    except Exception as exc:
        try:
            persistence.record_unexpected_failure(run_id, exc)
        except Exception:
            pass
        summary.update(status="failed", error_code="persistence_error", finished_at=_timestamp())
        return False, summary
    summary.update(asdict(persisted))
    summary["finished_at"] = _timestamp()
    return persisted.status == "succeeded", summary


def _next_delay(interval: int, consecutive_failures: int) -> int:
    return min(120, interval * (2 ** (consecutive_failures - 1)))


def run_watch(
    settings: Settings,
    source: RubusHttpSource,
    persistence: PostgresPersistence | None,
    interval: int,
    *,
    wait_for: Callable[[float], bool],
    shutdown_requested: Callable[[], bool],
    report: Callable[[dict[str, object]], None] = _print,
) -> None:
    consecutive_failures = 0
    attempt_number = 0
    while not shutdown_requested():
        attempt_number += 1
        succeeded, summary = run_attempt(settings, source, persistence, attempt_number)
        consecutive_failures = 0 if succeeded else consecutive_failures + 1
        delay = interval if succeeded else _next_delay(interval, consecutive_failures)
        summary["next_delay_seconds"] = delay
        report(summary)
        if shutdown_requested() or wait_for(delay):
            return


def _watch_with_signals(
    settings: Settings,
    source: RubusHttpSource,
    persistence: PostgresPersistence | None,
    interval: int,
) -> None:
    shutdown = threading.Event()
    previous_handlers = {signum: signal.getsignal(signum) for signum in (signal.SIGINT, signal.SIGTERM)}

    def request_shutdown(signum: int, frame: object) -> None:
        shutdown.set()

    try:
        for signum in previous_handlers:
            signal.signal(signum, request_shutdown)
        run_watch(settings, source, persistence, interval, wait_for=shutdown.wait, shutdown_requested=shutdown.is_set)
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


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
    persistence = None if args.dry_run else PostgresPersistence(settings.database_url or "")
    if args.watch:
        _watch_with_signals(settings, source, persistence, args.interval)
        return 0
    succeeded, summary = run_attempt(settings, source, persistence, 1)
    _print(summary)
    return 0 if succeeded or (args.dry_run and summary["status"] == "partial") else 1


if __name__ == "__main__":
    raise SystemExit(main())

