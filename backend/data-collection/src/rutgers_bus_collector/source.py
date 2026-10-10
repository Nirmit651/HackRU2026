from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib

import httpx


class SourceFetchError(RuntimeError):
    def __init__(self, message: str, *, code: str, http_status: int | None = None):
        super().__init__(message)
        self.code = code
        self.http_status = http_status


@dataclass(frozen=True)
class FetchResult:
    source_url: str
    retrieved_at: datetime
    http_status: int
    body: bytes
    content_type: str | None
    content_length: int
    sha256: str


class RubusHttpSource:
    def __init__(self, url: str, *, timeout_seconds: float, max_response_bytes: int):
        self._url = url
        self._timeout = timeout_seconds
        self._max_response_bytes = max_response_bytes

    def fetch(self) -> FetchResult:
        try:
            with httpx.Client(
                timeout=httpx.Timeout(self._timeout),
                follow_redirects=False,
                headers={"Accept": "application/json"},
            ) as client:
                response = client.get(self._url)
        except httpx.TimeoutException as exc:
            raise SourceFetchError("RUBus request timed out", code="timeout") from exc
        except httpx.HTTPError as exc:
            raise SourceFetchError("RUBus request failed", code="network_error") from exc

        retrieved_at = datetime.now(timezone.utc)
        body = response.content
        body_hash = hashlib.sha256(body).hexdigest()
        if len(body) > self._max_response_bytes:
            raise SourceFetchError(
                f"RUBus response exceeded {self._max_response_bytes} bytes",
                code="response_too_large",
                http_status=response.status_code,
            )
        if response.status_code != 200:
            raise SourceFetchError(
                f"RUBus returned HTTP {response.status_code}",
                code="http_error",
                http_status=response.status_code,
            )

        return FetchResult(
            source_url=self._url,
            retrieved_at=retrieved_at,
            http_status=response.status_code,
            body=body,
            content_type=response.headers.get("content-type"),
            content_length=len(body),
            sha256=body_hash,
        )

