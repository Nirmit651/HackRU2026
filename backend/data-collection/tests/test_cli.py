from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from io import StringIO
import json
import sys
import unittest
from unittest.mock import Mock, patch

from rutgers_bus_collector import cli
from rutgers_bus_collector.config import Settings
from rutgers_bus_collector.source import FetchResult


SETTINGS = Settings(
    rubus_bus_url="https://demo.rubus.live/buses",
    http_timeout_seconds=8,
    max_response_bytes=5_000_000,
    stale_after_seconds=120,
    project_ref="uyjnsuazcxwzoxauhmpm",
    database_url=None,
)


def valid_fetch(*, last_updated: str | None = "2026-10-10T17:05:24+00:00") -> FetchResult:
    body = json.dumps({"2764": {
        "name": "2764", "lat": 40.49, "lng": -74.43, "route": "wknd2",
        "capacity": 27, "riders": 16, "rotation": 169.0, "last_updated": last_updated,
    }}).encode()
    return FetchResult(
        source_url=SETTINGS.rubus_bus_url,
        retrieved_at=datetime(2026, 10, 10, 17, 5, 30, tzinfo=timezone.utc),
        http_status=200,
        body=body,
        content_type="application/json",
        content_length=len(body),
        sha256="0" * 64,
    )


class CliTests(unittest.TestCase):
    def test_intervals_default_valid_and_invalid(self) -> None:
        parser = cli._parser()
        self.assertEqual(parser.parse_args([]).interval, 15)
        self.assertEqual(parser.parse_args(["--interval", "5"]).interval, 5)
        self.assertEqual(parser.parse_args(["--interval", "300"]).interval, 300)
        with redirect_stderr(StringIO()):
            with self.assertRaises(SystemExit):
                parser.parse_args(["--interval", "4"])
            with self.assertRaises(SystemExit):
                parser.parse_args(["--interval", "301"])

    def test_one_shot_dry_run_prints_one_summary(self) -> None:
        source = Mock()
        source.fetch.return_value = valid_fetch()
        output = StringIO()
        with patch.object(cli.Settings, "from_environment", return_value=SETTINGS), \
             patch.object(cli, "RubusHttpSource", return_value=source), \
             patch.object(sys, "argv", ["collector", "--dry-run"]), \
             redirect_stdout(output):
            self.assertEqual(cli.main(), 0)
        summary = json.loads(output.getvalue())
        self.assertEqual(summary["attempt"], 1)
        self.assertEqual(summary["status"], "valid")

    def test_one_shot_dry_run_keeps_partial_exit_code(self) -> None:
        source = Mock()
        fetched = valid_fetch()
        body = json.dumps({
            "2764": json.loads(fetched.body)["2764"],
            "bad": {"lat": "not-a-number", "lng": -74.4, "route": "wknd1"},
        }).encode()
        source.fetch.return_value = FetchResult(
            source_url=fetched.source_url, retrieved_at=fetched.retrieved_at,
            http_status=fetched.http_status, body=body, content_type=fetched.content_type,
            content_length=len(body), sha256=fetched.sha256,
        )
        with patch.object(cli.Settings, "from_environment", return_value=SETTINGS), \
             patch.object(cli, "RubusHttpSource", return_value=source), \
             patch.object(sys, "argv", ["collector", "--dry-run"]), \
             redirect_stdout(StringIO()):
            self.assertEqual(cli.main(), 0)

    def test_watch_multiple_successes_are_sequential(self) -> None:
        reports: list[dict[str, object]] = []
        waits: list[float] = []
        outcomes = [(True, {"status": "valid"}), (True, {"status": "valid"})]
        with patch.object(cli, "run_attempt", side_effect=outcomes) as attempt:
            cli.run_watch(
                SETTINGS, Mock(), None, 15,
                wait_for=lambda delay: waits.append(delay) or False,
                shutdown_requested=lambda: len(reports) == 2,
                report=reports.append,
            )
        self.assertEqual(attempt.call_count, 2)
        self.assertEqual(waits, [15])
        self.assertEqual([item["next_delay_seconds"] for item in reports], [15, 15])

    def test_watch_recovers_and_resets_backoff(self) -> None:
        reports: list[dict[str, object]] = []
        outcomes = [(False, {"status": "fetch_failed"}), (True, {"status": "valid"}), (False, {"status": "invalid"})]
        with patch.object(cli, "run_attempt", side_effect=outcomes):
            cli.run_watch(
                SETTINGS, Mock(), None, 15,
                wait_for=lambda delay: False,
                shutdown_requested=lambda: len(reports) == 3,
                report=reports.append,
            )
        self.assertEqual([item["next_delay_seconds"] for item in reports], [15, 15, 15])

    def test_watch_backoff_grows_and_caps(self) -> None:
        reports: list[dict[str, object]] = []
        outcomes = [(False, {"status": "failed"}) for _ in range(6)]
        with patch.object(cli, "run_attempt", side_effect=outcomes):
            cli.run_watch(
                SETTINGS, Mock(), None, 5,
                wait_for=lambda delay: False,
                shutdown_requested=lambda: len(reports) == 6,
                report=reports.append,
            )
        self.assertEqual([item["next_delay_seconds"] for item in reports], [5, 10, 20, 40, 80, 120])

    def test_shutdown_while_waiting_starts_no_additional_attempt(self) -> None:
        reports: list[dict[str, object]] = []
        waits: list[float] = []
        with patch.object(cli, "run_attempt", return_value=(True, {"status": "valid"})) as attempt:
            cli.run_watch(
                SETTINGS, Mock(), None, 15,
                wait_for=lambda delay: waits.append(delay) or True,
                shutdown_requested=lambda: False,
                report=reports.append,
            )
        self.assertEqual(attempt.call_count, 1)
        self.assertEqual(waits, [15])
        self.assertEqual(len(reports), 1)

    def test_watch_dry_run_does_not_require_database(self) -> None:
        source = Mock()
        with patch.object(cli.Settings, "from_environment", return_value=SETTINGS) as from_environment, \
             patch.object(cli, "RubusHttpSource", return_value=source), \
             patch.object(cli, "_watch_with_signals") as watch, \
             patch.object(sys, "argv", ["collector", "--watch", "--dry-run"]):
            self.assertEqual(cli.main(), 0)
        self.assertEqual(from_environment.call_args.kwargs["require_database"], False)
        self.assertIsNone(watch.call_args.args[2])

    def test_missing_source_time_stays_retrieval_based(self) -> None:
        source = Mock()
        source.fetch.return_value = valid_fetch(last_updated=None)
        succeeded, summary = cli.run_attempt(SETTINGS, source, None, 1)
        self.assertTrue(succeeded)
        self.assertEqual(summary["source_time_status"], "missing")


if __name__ == "__main__":
    unittest.main()
