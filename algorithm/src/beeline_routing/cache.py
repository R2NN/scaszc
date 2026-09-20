from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .errors import CacheFrozen, CacheIntegrityError, UsageBudgetExceeded


def default_usage_ledger_path() -> Path:
    """Return one per-user ledger path shared by every response-cache file."""
    configured = os.environ.get('BEELINE_ROUTING_USAGE_LEDGER', '').strip()
    if configured:
        return Path(configured).expanduser().resolve()
    local_app_data = os.environ.get('LOCALAPPDATA', '').strip()
    if local_app_data:
        return Path(local_app_data) / 'beeline-routing' / 'usage.sqlite3'
    state_home = os.environ.get('XDG_STATE_HOME', '').strip()
    if state_home:
        return Path(state_home) / 'beeline-routing' / 'usage.sqlite3'
    return Path.home() / '.local' / 'state' / 'beeline-routing' / 'usage.sqlite3'


def canonical_json(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


@dataclass(frozen=True, slots=True)
class CachedResponse:
    request_sha256: str
    response_sha256: str
    response: Any
    fetched_at: str
    http_status: int


@dataclass(frozen=True, slots=True)
class CacheStatus:
    state: str
    response_count: int
    frozen_at: str | None
    snapshot_sha256: str | None


@dataclass(frozen=True, slots=True)
class UsageStatus:
    provider: str
    metric: str
    billing_period: str
    reserved_units: int
    hard_limit: int


class RoutingCache:
    """Контентно-адресуемый SQLite-кеш без API-ключей в данных."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.execute('PRAGMA foreign_keys=ON')
        return connection

    def _initialize(self) -> None:
        connection = self._connect()
        try:
            connection.execute('PRAGMA journal_mode=DELETE')
            connection.execute(
                '''
                CREATE TABLE IF NOT EXISTS api_responses (
                    request_sha256 TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    endpoint TEXT NOT NULL,
                    request_json TEXT NOT NULL,
                    response_sha256 TEXT NOT NULL,
                    response_json TEXT NOT NULL,
                    fetched_at TEXT NOT NULL,
                    http_status INTEGER NOT NULL CHECK (http_status BETWEEN 200 AND 299)
                ) STRICT
                '''
            )
            connection.execute(
                '''
                CREATE TABLE IF NOT EXISTS cache_metadata (
                    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
                    schema_version TEXT NOT NULL,
                    state TEXT NOT NULL CHECK (state IN ('OPEN', 'FROZEN')),
                    frozen_at TEXT,
                    snapshot_sha256 TEXT,
                    CHECK (
                        (state = 'OPEN' AND frozen_at IS NULL AND snapshot_sha256 IS NULL)
                        OR
                        (state = 'FROZEN' AND frozen_at IS NOT NULL AND snapshot_sha256 IS NOT NULL)
                    )
                ) STRICT
                '''
            )
            connection.execute(
                '''
                INSERT INTO cache_metadata (
                    singleton_id, schema_version, state, frozen_at, snapshot_sha256
                ) VALUES (1, '1.0.0', 'OPEN', NULL, NULL)
                ON CONFLICT(singleton_id) DO NOTHING
                '''
            )
            connection.execute(
                '''
                CREATE TABLE IF NOT EXISTS api_usage_reservations (
                    reservation_id INTEGER PRIMARY KEY,
                    provider TEXT NOT NULL,
                    metric TEXT NOT NULL,
                    billing_period TEXT NOT NULL,
                    units INTEGER NOT NULL CHECK (units > 0),
                    request_sha256 TEXT NOT NULL,
                    reserved_at TEXT NOT NULL
                ) STRICT
                '''
            )
            connection.commit()
        finally:
            connection.close()

    @staticmethod
    def request_hash(provider: str, endpoint: str, public_parameters: dict[str, Any]) -> tuple[str, str]:
        request_json = canonical_json(
            {'provider': provider, 'endpoint': endpoint, 'parameters': public_parameters}
        )
        return sha256_text(request_json), request_json

    def get(self, request_sha256: str) -> CachedResponse | None:
        connection = self._connect()
        try:
            row = connection.execute(
                '''
                SELECT response_sha256, response_json, fetched_at, http_status
                FROM api_responses
                WHERE request_sha256 = ?
                ''',
                (request_sha256,),
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            return None
        response_sha256, response_json, fetched_at, http_status = row
        if sha256_text(response_json) != response_sha256:
            raise CacheIntegrityError(f'Cached response checksum mismatch: {request_sha256}')
        return CachedResponse(
            request_sha256=request_sha256,
            response_sha256=response_sha256,
            response=json.loads(response_json),
            fetched_at=fetched_at,
            http_status=http_status,
        )

    def put(
        self,
        *,
        request_sha256: str,
        provider: str,
        endpoint: str,
        request_json: str,
        response: Any,
        http_status: int,
        replace: bool = False,
    ) -> CachedResponse:
        response_json = canonical_json(response)
        response_sha256 = sha256_text(response_json)
        fetched_at = datetime.now(UTC).isoformat()
        conflict_action = '''
                ON CONFLICT(request_sha256) DO UPDATE SET
                    provider = excluded.provider,
                    endpoint = excluded.endpoint,
                    request_json = excluded.request_json,
                    response_sha256 = excluded.response_sha256,
                    response_json = excluded.response_json,
                    fetched_at = excluded.fetched_at,
                    http_status = excluded.http_status
                ''' if replace else 'ON CONFLICT(request_sha256) DO NOTHING'
        connection = self._connect()
        try:
            connection.execute('BEGIN IMMEDIATE')
            state = connection.execute(
                'SELECT state FROM cache_metadata WHERE singleton_id = 1'
            ).fetchone()
            if state is None or state[0] != 'OPEN':
                raise CacheFrozen('Routing snapshot is FROZEN and cannot be modified')
            connection.execute(
                f'''
                INSERT INTO api_responses (
                    request_sha256, provider, endpoint, request_json,
                    response_sha256, response_json, fetched_at, http_status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                {conflict_action}
                ''',
                (
                    request_sha256,
                    provider,
                    endpoint,
                    request_json,
                    response_sha256,
                    response_json,
                    fetched_at,
                    http_status,
                ),
            )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()
        stored = self.get(request_sha256)
        if stored is None:
            raise CacheIntegrityError(f'Failed to persist cached response: {request_sha256}')
        return stored

    def status(self) -> CacheStatus:
        connection = self._connect()
        try:
            metadata = connection.execute(
                '''
                SELECT state, frozen_at, snapshot_sha256
                FROM cache_metadata
                WHERE singleton_id = 1
                '''
            ).fetchone()
            response_count = connection.execute('SELECT COUNT(*) FROM api_responses').fetchone()[0]
        finally:
            connection.close()
        if metadata is None:
            raise CacheIntegrityError('Routing cache metadata is missing')
        return CacheStatus(
            state=str(metadata[0]),
            response_count=int(response_count),
            frozen_at=metadata[1],
            snapshot_sha256=metadata[2],
        )

    def assert_writable(self) -> None:
        if self.status().state != 'OPEN':
            raise CacheFrozen('Routing snapshot is FROZEN; network access and refresh are forbidden')

    def reserve_usage(
        self,
        *,
        provider: str,
        metric: str,
        units: int,
        hard_limit: int,
        request_sha256: str,
        billing_period: str | None = None,
    ) -> UsageStatus:
        """Atomically reserve billable units before every physical network attempt."""
        if units < 1:
            raise ValueError('usage units must be positive')
        if hard_limit < 1:
            raise ValueError('hard_limit must be positive')
        period = billing_period or datetime.now(UTC).strftime('%Y-%m')
        connection = self._connect()
        try:
            connection.execute('BEGIN IMMEDIATE')
            current = int(
                connection.execute(
                    '''
                    SELECT COALESCE(SUM(units), 0)
                    FROM api_usage_reservations
                    WHERE provider = ? AND metric = ? AND billing_period = ?
                    ''',
                    (provider, metric, period),
                ).fetchone()[0]
            )
            if current + units > hard_limit:
                raise UsageBudgetExceeded(
                    f'Hard usage limit reached for {provider}/{metric}: '
                    f'{current} reserved, {units} requested, limit {hard_limit}, period {period}'
                )
            connection.execute(
                '''
                INSERT INTO api_usage_reservations (
                    provider, metric, billing_period, units, request_sha256, reserved_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ''',
                (
                    provider,
                    metric,
                    period,
                    units,
                    request_sha256,
                    datetime.now(UTC).isoformat(),
                ),
            )
            connection.commit()
            return UsageStatus(provider, metric, period, current + units, hard_limit)
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def usage_status(
        self,
        *,
        provider: str,
        metric: str,
        hard_limit: int,
        billing_period: str | None = None,
    ) -> UsageStatus:
        period = billing_period or datetime.now(UTC).strftime('%Y-%m')
        connection = self._connect()
        try:
            reserved = int(
                connection.execute(
                    '''
                    SELECT COALESCE(SUM(units), 0)
                    FROM api_usage_reservations
                    WHERE provider = ? AND metric = ? AND billing_period = ?
                    ''',
                    (provider, metric, period),
                ).fetchone()[0]
            )
        finally:
            connection.close()
        return UsageStatus(provider, metric, period, reserved, hard_limit)

    @staticmethod
    def _verify_rows(connection: sqlite3.Connection) -> str:
        integrity_result = connection.execute('PRAGMA integrity_check').fetchone()
        if integrity_result is None or integrity_result[0] != 'ok':
            raise CacheIntegrityError(f'SQLite integrity check failed: {integrity_result}')
        rows = connection.execute(
                '''
                SELECT request_sha256, request_json, response_sha256, response_json,
                       fetched_at, http_status
                FROM api_responses
                ORDER BY request_sha256
                '''
            ).fetchall()
        digest_rows: list[dict[str, Any]] = []
        for request_sha256, request_json, response_sha256, response_json, fetched_at, http_status in rows:
            if sha256_text(request_json) != request_sha256:
                raise CacheIntegrityError(f'Request checksum mismatch: {request_sha256}')
            if sha256_text(response_json) != response_sha256:
                raise CacheIntegrityError(f'Response checksum mismatch: {request_sha256}')
            try:
                json.loads(request_json)
                json.loads(response_json)
            except json.JSONDecodeError as error:
                raise CacheIntegrityError(f'Invalid cached JSON: {request_sha256}') from error
            digest_rows.append(
                {
                    'request_sha256': request_sha256,
                    'response_sha256': response_sha256,
                    'fetched_at': fetched_at,
                    'http_status': http_status,
                }
            )
        return sha256_text(canonical_json(digest_rows))

    def verify_integrity(self) -> str:
        connection = self._connect()
        try:
            return self._verify_rows(connection)
        finally:
            connection.close()

    def freeze(self) -> CacheStatus:
        connection = self._connect()
        result: CacheStatus | None = None
        try:
            connection.execute('BEGIN IMMEDIATE')
            snapshot_sha256 = self._verify_rows(connection)
            current = connection.execute(
                'SELECT state, snapshot_sha256 FROM cache_metadata WHERE singleton_id = 1'
            ).fetchone()
            if current is None:
                raise CacheIntegrityError('Routing cache metadata is missing')
            if current[0] == 'FROZEN':
                if current[1] != snapshot_sha256:
                    raise CacheIntegrityError('Frozen snapshot hash does not match cached responses')
                connection.commit()
                metadata = connection.execute(
                    '''
                    SELECT state, frozen_at, snapshot_sha256
                    FROM cache_metadata WHERE singleton_id = 1
                    '''
                ).fetchone()
            else:
                frozen_at = datetime.now(UTC).isoformat()
                connection.execute(
                    '''
                    UPDATE cache_metadata
                    SET state = 'FROZEN', frozen_at = ?, snapshot_sha256 = ?
                    WHERE singleton_id = 1
                    ''',
                    (frozen_at, snapshot_sha256),
                )
                connection.commit()
                metadata = ('FROZEN', frozen_at, snapshot_sha256)
            response_count = connection.execute('SELECT COUNT(*) FROM api_responses').fetchone()[0]
            connection.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            journal_mode = connection.execute('PRAGMA journal_mode=DELETE').fetchone()
            if journal_mode is None or str(journal_mode[0]).lower() != 'delete':
                raise CacheIntegrityError(f'Failed to create a single-file snapshot: {journal_mode}')
            result = CacheStatus(
                state=str(metadata[0]),
                response_count=int(response_count),
                frozen_at=metadata[1],
                snapshot_sha256=metadata[2],
            )
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()
        if result is None:
            raise CacheIntegrityError('Failed to freeze routing cache')
        return result
