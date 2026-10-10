from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
from typing import Any

from .source import FetchResult


KNOWN_ROUTES = frozenset(
    {
        "a", "b", "bhe", "ee", "f", "h", "lx", "on1", "on2", "rexb",
        "rexl", "wknd1", "wknd2", "c", "ftbl", "all", "winter1",
        "winter2", "bl", "summer1", "summer2", "commencement", "helix",
        "kbs", "cam", "cc", "ccx", "ps", "psx",
    }
)
ROUTE_ALIASES = {"onwk1fs": "on1", "onwk2fs": "on2"}
EVIDENCE_FIELDS = frozenset(
    {"name", "lat", "lng", "route", "capacity", "riders", "rotation", "last_updated"}
)


@dataclass(frozen=True)
class ValidationIssue:
    code: str
    message: str
    vehicle_id: str | None = None

    def as_dict(self) -> dict[str, str]:
        value = {"code": self.code, "message": self.message}
        if self.vehicle_id is not None:
            value["vehicle_id"] = self.vehicle_id
        return value


@dataclass(frozen=True)
class Observation:
    vehicle_id: str
    route_id: str
    source_measured_at: datetime | None
    retrieved_at: datetime
    measurement_time_basis: str
    latitude: float
    longitude: float
    rotation_degrees: float | None
    occupancy_percent: float | None
    rider_count: int | None
    quality_flags: tuple[str, ...]


@dataclass(frozen=True)
class NormalizationResult:
    payload: dict[str, Any] | None
    observations: tuple[Observation, ...]
    issues: tuple[ValidationIssue, ...]
    fatal_issue: ValidationIssue | None
    source_time_status: str
    source_measured_at: datetime | None
    is_complete: bool

    @property
    def received_count(self) -> int:
        return len(self.payload) if self.payload is not None else 0

    @property
    def invalid_count(self) -> int:
        return self.received_count - len(self.observations)


def _number(value: Any, *, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be numeric")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{field} must be finite")
    return result


def _optional_integer(value: Any, *, field: str, minimum: int = 0) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{field} must be an integer or null")
    if value < minimum:
        raise ValueError(f"{field} must be at least {minimum}")
    return value


def _parse_source_time(value: Any) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError("last_updated must be a timezone-aware timestamp or null")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("last_updated is not valid ISO-8601") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("last_updated must include a timezone offset")
    return parsed.astimezone(timezone.utc)


def _normalize_route(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("route must be a non-empty string")
    candidate = value.strip().lower()
    candidate = ROUTE_ALIASES.get(candidate, candidate)
    if candidate not in KNOWN_ROUTES:
        raise ValueError(f"route is outside the verified RUBus scope: {value!r}")
    return candidate


def normalize_snapshot(fetch: FetchResult, *, stale_after_seconds: int) -> NormalizationResult:
    if not fetch.content_type or "application/json" not in fetch.content_type.lower():
        issue = ValidationIssue("unexpected_content_type", "response is not application/json")
        return NormalizationResult(None, (), (issue,), issue, "missing", None, False)

    try:
        decoded = json.loads(fetch.body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        issue = ValidationIssue("malformed_json", "response is not valid JSON")
        return NormalizationResult(None, (), (issue,), issue, "missing", None, False)

    if not isinstance(decoded, dict):
        issue = ValidationIssue("invalid_top_level", "response must be an object keyed by vehicle ID")
        return NormalizationResult(None, (), (issue,), issue, "missing", None, False)
    if "error" in decoded:
        issue = ValidationIssue("source_error", "response contains a source error marker")
        return NormalizationResult({"error": True}, (), (issue,), issue, "missing", None, False)
    if not decoded:
        issue = ValidationIssue(
            "unexpected_empty_snapshot",
            "empty response is not accepted as a valid zero-bus snapshot",
        )
        return NormalizationResult(decoded, (), (issue,), issue, "missing", None, False)

    evidence_payload = {
        str(vehicle_id): (
            {key: value for key, value in record.items() if key in EVIDENCE_FIELDS}
            if isinstance(record, dict)
            else record
        )
        for vehicle_id, record in decoded.items()
    }
    observations: list[Observation] = []
    issues: list[ValidationIssue] = []
    provided_times: list[datetime] = []
    missing_time_count = 0

    for raw_vehicle_id, raw_record in decoded.items():
        vehicle_id = str(raw_vehicle_id).strip()
        try:
            if not vehicle_id:
                raise ValueError("vehicle ID must not be blank")
            if not isinstance(raw_record, dict):
                raise ValueError("vehicle record must be an object")
            source_name = raw_record.get("name")
            if source_name is not None and str(source_name).strip() != vehicle_id:
                raise ValueError("vehicle key does not match source name")

            latitude = _number(raw_record.get("lat"), field="lat")
            longitude = _number(raw_record.get("lng"), field="lng")
            if not -90 <= latitude <= 90:
                raise ValueError("lat is outside [-90, 90]")
            if not -180 <= longitude <= 180:
                raise ValueError("lng is outside [-180, 180]")
            route_id = _normalize_route(raw_record.get("route"))
            source_time = _parse_source_time(raw_record.get("last_updated"))

            rotation_raw = raw_record.get("rotation")
            rotation = None if rotation_raw is None else _number(rotation_raw, field="rotation")
            if rotation is not None and not 0 <= rotation <= 360:
                raise ValueError("rotation is outside [0, 360]")

            occupancy_raw = raw_record.get("capacity")
            occupancy = None if occupancy_raw is None else _number(occupancy_raw, field="capacity")
            if occupancy is not None and not 0 <= occupancy <= 100:
                raise ValueError("capacity/occupancy percentage is outside [0, 100]")
            riders = _optional_integer(raw_record.get("riders"), field="riders")

            flags: list[str] = []
            if source_time is None:
                missing_time_count += 1
                flags.append("missing_source_measurement_time")
            else:
                provided_times.append(source_time)
                age_seconds = (fetch.retrieved_at - source_time).total_seconds()
                if age_seconds > stale_after_seconds:
                    flags.append("stale_source_measurement")
                if age_seconds < -300:
                    raise ValueError("last_updated is more than five minutes in the future")

            observations.append(
                Observation(
                    vehicle_id=vehicle_id,
                    route_id=route_id,
                    source_measured_at=source_time,
                    retrieved_at=fetch.retrieved_at,
                    measurement_time_basis="source" if source_time else "retrieval",
                    latitude=latitude,
                    longitude=longitude,
                    rotation_degrees=rotation,
                    occupancy_percent=occupancy,
                    rider_count=riders,
                    quality_flags=tuple(flags),
                )
            )
        except ValueError as exc:
            issues.append(ValidationIssue("invalid_vehicle", str(exc), vehicle_id or None))

    if not observations:
        fatal = ValidationIssue("no_valid_vehicles", "response contains no valid vehicle records")
        issues.append(fatal)
        return NormalizationResult(evidence_payload, (), tuple(issues), fatal, "missing", None, False)

    unique_times = set(provided_times)
    if not provided_times:
        source_time_status = "missing"
        snapshot_source_time = None
    elif missing_time_count == 0 and len(unique_times) == 1:
        source_time_status = "provided"
        snapshot_source_time = provided_times[0]
    else:
        source_time_status = "mixed"
        snapshot_source_time = None

    return NormalizationResult(
        payload=evidence_payload,
        observations=tuple(observations),
        issues=tuple(issues),
        fatal_issue=None,
        source_time_status=source_time_status,
        source_measured_at=snapshot_source_time,
        is_complete=not issues and len(observations) == len(decoded),
    )

