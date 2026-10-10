from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
from typing import Any
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from .normalize import NormalizationResult
from .source import FetchResult, SourceFetchError


SOURCE_SYSTEM = "rubus"
TRANSPORT = "http_snapshot"


@dataclass(frozen=True)
class PersistedResult:
    run_id: UUID
    snapshot_id: UUID | None
    status: str
    received_count: int
    valid_count: int
    invalid_count: int
    inserted_observation_count: int
    duplicate_observation_count: int


class PostgresPersistence:
    def __init__(self, database_url: str):
        self._database_url = database_url

    def _connect(self) -> psycopg.Connection[Any]:
        return psycopg.connect(
            self._database_url,
            connect_timeout=8,
            prepare_threshold=None,
        )

    def start_run(self, source_url: str) -> UUID:
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    insert into public.bus_collection_runs (
                        source_system, transport, source_endpoint, status
                    ) values (%s, %s, %s, 'running')
                    returning id
                    """,
                    (SOURCE_SYSTEM, TRANSPORT, source_url),
                )
                row = cursor.fetchone()
                assert row is not None
                return row[0]

    def record_fetch_failure(self, run_id: UUID, error: SourceFetchError) -> None:
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    update public.bus_collection_runs
                    set status = 'failed', completed_at = %s, http_status = %s,
                        is_complete = false, error_code = %s, error_message = %s,
                        quality_summary = %s
                    where id = %s and status = 'running'
                    """,
                    (
                        datetime.now(timezone.utc),
                        error.http_status,
                        error.code,
                        str(error)[:2000],
                        Jsonb({"stage": "fetch"}),
                        run_id,
                    ),
                )

    def record_unexpected_failure(self, run_id: UUID, error: Exception) -> None:
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    update public.bus_collection_runs
                    set status = 'failed', completed_at = %s, is_complete = false,
                        error_code = 'persistence_error', error_message = %s,
                        quality_summary = %s
                    where id = %s and status = 'running'
                    """,
                    (
                        datetime.now(timezone.utc),
                        f"{type(error).__name__}: {error}"[:2000],
                        Jsonb({"stage": "persistence"}),
                        run_id,
                    ),
                )

    def persist(
        self,
        run_id: UUID,
        fetch: FetchResult,
        normalized: NormalizationResult,
    ) -> PersistedResult:
        status = "failed" if normalized.fatal_issue else ("succeeded" if normalized.is_complete else "partial")
        snapshot_id: UUID | None = None
        inserted_count = 0

        issues = [issue.as_dict() for issue in normalized.issues[:50]]
        evidence_ref = f"sha256:{fetch.sha256};source:{fetch.source_url}"
        quality_summary = {
            "content_type": fetch.content_type,
            "payload_sha256": fetch.sha256,
            "inserted_observations": 0,
            "duplicate_observations": 0,
            "issues": issues,
        }

        with self._connect() as connection:
            with connection.transaction():
                with connection.cursor() as cursor:
                    if normalized.payload is not None:
                        cursor.execute(
                            """
                            insert into public.bus_snapshots (
                                collection_run_id, source_system, transport, message_kind,
                                retrieved_at, source_measured_at, source_time_status,
                                is_complete, is_valid, record_count, payload_sha256,
                                payload, quality_flags, evidence_ref
                            ) values (
                                %s, %s, %s, 'vehicle_snapshot', %s, %s, %s,
                                %s, %s, %s, %s, %s, %s, %s
                            ) returning id
                            """,
                            (
                                run_id,
                                SOURCE_SYSTEM,
                                TRANSPORT,
                                fetch.retrieved_at,
                                normalized.source_measured_at,
                                normalized.source_time_status,
                                normalized.is_complete,
                                normalized.fatal_issue is None and not normalized.issues,
                                normalized.received_count,
                                fetch.sha256,
                                Jsonb(normalized.payload),
                                Jsonb(issues),
                                evidence_ref,
                            ),
                        )
                        snapshot_row = cursor.fetchone()
                        assert snapshot_row is not None
                        snapshot_id = snapshot_row[0]

                    if snapshot_id is not None and normalized.fatal_issue is None:
                        for observation in normalized.observations:
                            cursor.execute(
                                """
                                insert into public.bus_observations (
                                    collection_run_id, snapshot_id, source_system,
                                    observation_kind, vehicle_id, route_id,
                                    source_measured_at, retrieved_at, measurement_time_basis,
                                    latitude, longitude, rotation_degrees,
                                    occupancy_percent, rider_count, is_valid,
                                    quality_flags, evidence_ref
                                ) values (
                                    %s, %s, %s, 'vehicle_position', %s, %s,
                                    %s, %s, %s, %s, %s, %s, %s, %s, true, %s, %s
                                )
                                on conflict do nothing
                                returning id
                                """,
                                (
                                    run_id,
                                    snapshot_id,
                                    SOURCE_SYSTEM,
                                    observation.vehicle_id,
                                    observation.route_id,
                                    observation.source_measured_at,
                                    observation.retrieved_at,
                                    observation.measurement_time_basis,
                                    observation.latitude,
                                    observation.longitude,
                                    observation.rotation_degrees,
                                    observation.occupancy_percent,
                                    observation.rider_count,
                                    Jsonb(list(observation.quality_flags)),
                                    evidence_ref,
                                ),
                            )
                            if cursor.fetchone() is not None:
                                inserted_count += 1

                        observed_routes = sorted({item.route_id for item in normalized.observations})
                        cursor.execute(
                            """
                            update public.bus_routes
                            set last_verified_at = greatest(
                                    coalesce(last_verified_at, '-infinity'::timestamptz), %s
                                ),
                                updated_at = now()
                            where source_system = %s and route_id = any(%s)
                            """,
                            (fetch.retrieved_at, SOURCE_SYSTEM, observed_routes),
                        )

                    duplicate_count = len(normalized.observations) - inserted_count
                    quality_summary["inserted_observations"] = inserted_count
                    quality_summary["duplicate_observations"] = duplicate_count
                    error = normalized.fatal_issue
                    cursor.execute(
                        """
                        update public.bus_collection_runs
                        set status = %s, completed_at = %s, http_status = %s,
                            records_received = %s, records_valid = %s,
                            records_invalid = %s, response_bytes = %s,
                            is_complete = %s, error_code = %s, error_message = %s,
                            quality_summary = %s, evidence_ref = %s
                        where id = %s and status = 'running'
                        """,
                        (
                            status,
                            datetime.now(timezone.utc),
                            fetch.http_status,
                            normalized.received_count,
                            len(normalized.observations),
                            normalized.invalid_count,
                            fetch.content_length,
                            normalized.is_complete,
                            error.code if error else None,
                            error.message if error else None,
                            Jsonb(quality_summary),
                            evidence_ref,
                            run_id,
                        ),
                    )
                    if cursor.rowcount != 1:
                        raise RuntimeError("collection run was not in the expected running state")

        return PersistedResult(
            run_id=run_id,
            snapshot_id=snapshot_id,
            status=status,
            received_count=normalized.received_count,
            valid_count=len(normalized.observations),
            invalid_count=normalized.invalid_count,
            inserted_observation_count=inserted_count,
            duplicate_observation_count=len(normalized.observations) - inserted_count,
        )

