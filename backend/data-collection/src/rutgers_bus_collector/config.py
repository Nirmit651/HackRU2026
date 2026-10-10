from __future__ import annotations

from dataclasses import dataclass
import os
from urllib.parse import urlsplit


EXPECTED_PROJECT_REF = "uyjnsuazcxwzoxauhmpm"
VERIFIED_RUBUS_HOST = "demo.rubus.live"
VERIFIED_RUBUS_PATH = "/buses"


class ConfigurationError(ValueError):
    pass


def _positive_float(name: str, default: str) -> float:
    raw = os.getenv(name, default)
    try:
        value = float(raw)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be numeric") from exc
    if value <= 0:
        raise ConfigurationError(f"{name} must be greater than zero")
    return value


def _positive_int(name: str, default: str) -> int:
    raw = os.getenv(name, default)
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be an integer") from exc
    if value <= 0:
        raise ConfigurationError(f"{name} must be greater than zero")
    return value


@dataclass(frozen=True)
class Settings:
    rubus_bus_url: str
    http_timeout_seconds: float
    max_response_bytes: int
    stale_after_seconds: int
    project_ref: str
    database_url: str | None

    @classmethod
    def from_environment(cls, *, require_database: bool = True) -> "Settings":
        bus_url = os.getenv("RUBUS_BUS_URL", "https://demo.rubus.live/buses")
        parsed = urlsplit(bus_url)
        if (
            parsed.scheme != "https"
            or parsed.hostname != VERIFIED_RUBUS_HOST
            or parsed.path.rstrip("/") != VERIFIED_RUBUS_PATH
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ConfigurationError(
                "RUBUS_BUS_URL must be the verified credential-free HTTPS /buses endpoint"
            )

        project_ref = os.getenv("SUPABASE_PROJECT_REF", EXPECTED_PROJECT_REF)
        if project_ref != EXPECTED_PROJECT_REF:
            raise ConfigurationError(
                f"SUPABASE_PROJECT_REF must be {EXPECTED_PROJECT_REF}"
            )

        database_url = os.getenv("SUPABASE_DB_URL")
        if require_database and not database_url:
            raise ConfigurationError("SUPABASE_DB_URL is required for persistence")
        if database_url and project_ref not in database_url:
            raise ConfigurationError(
                "SUPABASE_DB_URL does not contain the expected project reference"
            )

        return cls(
            rubus_bus_url=bus_url,
            http_timeout_seconds=_positive_float("RUBUS_HTTP_TIMEOUT_SECONDS", "8"),
            max_response_bytes=_positive_int("RUBUS_MAX_RESPONSE_BYTES", "5000000"),
            stale_after_seconds=_positive_int("RUBUS_STALE_AFTER_SECONDS", "120"),
            project_ref=project_ref,
            database_url=database_url,
        )

