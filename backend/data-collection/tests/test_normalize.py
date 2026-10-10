from __future__ import annotations

from datetime import datetime, timezone
import json
import unittest

from rutgers_bus_collector.normalize import normalize_snapshot
from rutgers_bus_collector.source import FetchResult


def fetched(payload: object, *, retrieved_at: str = "2026-10-10T17:05:30+00:00") -> FetchResult:
    body = json.dumps(payload).encode()
    return FetchResult(
        source_url="https://demo.rubus.live/buses",
        retrieved_at=datetime.fromisoformat(retrieved_at),
        http_status=200,
        body=body,
        content_type="application/json",
        content_length=len(body),
        sha256="0" * 64,
    )


class NormalizeSnapshotTests(unittest.TestCase):
    def test_non_json_content_type_is_fatal(self) -> None:
        result_fetch = fetched({"2764": {}})
        result_fetch = FetchResult(
            source_url=result_fetch.source_url,
            retrieved_at=result_fetch.retrieved_at,
            http_status=result_fetch.http_status,
            body=result_fetch.body,
            content_type="text/html",
            content_length=result_fetch.content_length,
            sha256=result_fetch.sha256,
        )
        result = normalize_snapshot(result_fetch, stale_after_seconds=120)
        self.assertEqual(result.fatal_issue.code, "unexpected_content_type")

    def test_valid_record_preserves_source_and_retrieval_times(self) -> None:
        result = normalize_snapshot(
            fetched(
                {
                    "2764": {
                        "name": "2764",
                        "lat": 40.4963355,
                        "lng": -74.4399823,
                        "route": "wknd2",
                        "capacity": 27,
                        "riders": 16,
                        "rotation": 169.0,
                        "last_updated": "2026-10-10T17:05:24.248347+00:00",
                    }
                }
            ),
            stale_after_seconds=120,
        )
        self.assertTrue(result.is_complete)
        self.assertEqual(result.source_time_status, "provided")
        self.assertEqual(result.observations[0].measurement_time_basis, "source")
        self.assertNotEqual(result.observations[0].source_measured_at, result.observations[0].retrieved_at)
        self.assertEqual(result.observations[0].occupancy_percent, 27)

    def test_empty_snapshot_is_fatal(self) -> None:
        result = normalize_snapshot(fetched({}), stale_after_seconds=120)
        self.assertIsNotNone(result.fatal_issue)
        self.assertFalse(result.is_complete)
        self.assertEqual(result.received_count, 0)

    def test_partial_snapshot_keeps_valid_history_but_is_not_complete(self) -> None:
        result = normalize_snapshot(
            fetched(
                {
                    "2764": {
                        "name": "2764",
                        "lat": 40.49,
                        "lng": -74.43,
                        "route": "wknd2",
                        "capacity": 27,
                        "riders": 16,
                        "rotation": None,
                        "last_updated": None,
                    },
                    "bad": {"lat": "not-a-number", "lng": -74.4, "route": "wknd1"},
                }
            ),
            stale_after_seconds=120,
        )
        self.assertIsNone(result.fatal_issue)
        self.assertFalse(result.is_complete)
        self.assertEqual(len(result.observations), 1)
        self.assertEqual(result.invalid_count, 1)
        self.assertEqual(result.observations[0].measurement_time_basis, "retrieval")

    def test_unknown_route_is_rejected(self) -> None:
        result = normalize_snapshot(
            fetched(
                {
                    "2764": {
                        "name": "2764",
                        "lat": 40.49,
                        "lng": -74.43,
                        "route": "invented-route",
                        "capacity": 27,
                        "riders": 16,
                        "rotation": None,
                        "last_updated": "2026-10-10T17:05:24+00:00",
                    }
                }
            ),
            stale_after_seconds=120,
        )
        self.assertIsNotNone(result.fatal_issue)
        self.assertEqual(len(result.observations), 0)


if __name__ == "__main__":
    unittest.main()

