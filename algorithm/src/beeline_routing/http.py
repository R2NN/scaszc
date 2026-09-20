from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .cache import CachedResponse, RoutingCache, default_usage_ledger_path
from .errors import InvalidRoutingInput, ProviderHttpError, ProviderResponseError


@dataclass(frozen=True, slots=True)
class JsonResponse:
    payload: Any
    request_sha256: str
    response_sha256: str
    fetched_at: str
    cache_hit: bool
    http_status: int


class JsonHttpClient:
    def __init__(
        self,
        *,
        cache: RoutingCache,
        timeout_seconds: float = 30,
        max_attempts: int = 4,
        max_response_bytes: int = 64 * 1024 * 1024,
        opener: Callable[..., Any] = urllib.request.urlopen,
        sleeper: Callable[[float], None] = time.sleep,
        usage_ledger: RoutingCache | None = None,
    ) -> None:
        if timeout_seconds <= 0:
            raise ValueError('timeout_seconds must be positive')
        if max_attempts < 1:
            raise ValueError('max_attempts must be at least 1')
        if max_response_bytes < 1:
            raise ValueError('max_response_bytes must be positive')
        self.cache = cache
        self.timeout_seconds = timeout_seconds
        self.max_attempts = max_attempts
        self.max_response_bytes = max_response_bytes
        self.opener = opener
        self.sleeper = sleeper
        self.usage_ledger = usage_ledger or RoutingCache(default_usage_ledger_path())

    def get_json(
        self,
        *,
        provider: str,
        endpoint: str,
        public_parameters: dict[str, Any],
        secret_parameters: dict[str, str],
        before_network: Callable[[], None] | None = None,
        validate_payload: Callable[[Any, str], None] | None = None,
        refresh: bool = False,
    ) -> JsonResponse:
        return self._request_json(
            method='GET',
            provider=provider,
            endpoint=endpoint,
            public_parameters=public_parameters,
            secret_parameters=secret_parameters,
            json_body=None,
            before_network=before_network,
            validate_payload=validate_payload,
            refresh=refresh,
            empty_response_statuses=frozenset(),
        )

    def post_json(
        self,
        *,
        provider: str,
        endpoint: str,
        public_parameters: dict[str, Any],
        secret_parameters: dict[str, str],
        json_body: dict[str, Any],
        before_network: Callable[[], None] | None = None,
        validate_payload: Callable[[Any, str], None] | None = None,
        refresh: bool = False,
        empty_response_statuses: frozenset[int] = frozenset(),
    ) -> JsonResponse:
        return self._request_json(
            method='POST',
            provider=provider,
            endpoint=endpoint,
            public_parameters=public_parameters,
            secret_parameters=secret_parameters,
            json_body=json_body,
            before_network=before_network,
            validate_payload=validate_payload,
            refresh=refresh,
            empty_response_statuses=empty_response_statuses,
        )

    def _request_json(
        self,
        *,
        method: str,
        provider: str,
        endpoint: str,
        public_parameters: dict[str, Any],
        secret_parameters: dict[str, str],
        json_body: dict[str, Any] | None,
        before_network: Callable[[], None] | None,
        validate_payload: Callable[[Any, str], None] | None,
        refresh: bool,
        empty_response_statuses: frozenset[int],
    ) -> JsonResponse:
        if set(public_parameters) & set(secret_parameters):
            raise InvalidRoutingInput('A parameter cannot be both public and secret')
        sensitive_names = {'apikey', 'api_key', 'token', 'access_token', 'authorization', 'signature'}
        exposed_names = {name.lower() for name in public_parameters} & sensitive_names
        if exposed_names:
            raise InvalidRoutingInput(
                f'Sensitive parameters must be passed via secret_parameters: {sorted(exposed_names)}'
            )
        request_identity: dict[str, Any] = public_parameters
        if method == 'POST':
            request_identity = {'method': method, 'query': public_parameters, 'body': json_body}
        request_sha256, request_json = self.cache.request_hash(provider, endpoint, request_identity)
        if not refresh:
            cached = self.cache.get(request_sha256)
            if cached is not None:
                if validate_payload is not None:
                    validate_payload(cached.response, request_sha256)
                return self._from_cached(cached)

        self.cache.assert_writable()

        parameters = {**public_parameters, **secret_parameters}
        query = urllib.parse.urlencode(parameters, safe='|,')
        body_bytes = None
        headers = {'Accept': 'application/json', 'User-Agent': 'beeline-routing/0.1.0'}
        if json_body is not None:
            body_bytes = json.dumps(
                json_body,
                ensure_ascii=False,
                sort_keys=True,
                separators=(',', ':'),
            ).encode('utf-8')
            headers['Content-Type'] = 'application/json; charset=utf-8'
        request = urllib.request.Request(
            f'{endpoint}?{query}',
            data=body_bytes,
            headers=headers,
            method=method,
        )
        retryable_statuses = {429, 500, 502, 503, 504}
        last_error: Exception | None = None
        for attempt in range(1, self.max_attempts + 1):
            try:
                if before_network is not None:
                    before_network()
                with self.opener(request, timeout=self.timeout_seconds) as response:
                    status = int(response.status)
                    final_url = response.geturl() if hasattr(response, 'geturl') else request.full_url
                    requested_address = urllib.parse.urlsplit(endpoint)
                    final_address = urllib.parse.urlsplit(final_url)
                    if (
                        final_address.scheme != requested_address.scheme
                        or final_address.netloc != requested_address.netloc
                    ):
                        raise ProviderHttpError(
                            f'{provider} redirected outside the authorized endpoint; '
                            f'request_sha256={request_sha256}'
                        )
                    raw = response.read(self.max_response_bytes + 1)
                if not 200 <= status <= 299:
                    raise ProviderHttpError(
                        f'{provider} HTTP {status}; endpoint={endpoint}; '
                        f'request_sha256={request_sha256}'
                    )
                if len(raw) > self.max_response_bytes:
                    raise ProviderResponseError(
                        f'{provider} response exceeds {self.max_response_bytes} bytes; '
                        f'request_sha256={request_sha256}'
                    )
                response_text = raw.decode('utf-8')
                if status in empty_response_statuses and not response_text.strip():
                    payload = None
                else:
                    payload = json.loads(
                        response_text,
                        parse_constant=lambda value: self._reject_json_constant(value, request_sha256),
                    )
                    if not isinstance(payload, (dict, list)):
                        raise ProviderResponseError('Provider JSON root must be an object or array')
                leaked_secret_names = sorted(
                    name
                    for name, value in secret_parameters.items()
                    if value and value in response_text
                )
                if leaked_secret_names:
                    raise ProviderResponseError(
                        'Provider response echoed secret parameters; response was not cached: '
                        f'{leaked_secret_names}'
                    )
                if validate_payload is not None:
                    validate_payload(payload, request_sha256)
                stored = self.cache.put(
                    request_sha256=request_sha256,
                    provider=provider,
                    endpoint=endpoint,
                    request_json=request_json,
                    response=payload,
                    http_status=status,
                    replace=refresh,
                )
                return JsonResponse(
                    payload=stored.response,
                    request_sha256=stored.request_sha256,
                    response_sha256=stored.response_sha256,
                    fetched_at=stored.fetched_at,
                    cache_hit=False,
                    http_status=stored.http_status,
                )
            except urllib.error.HTTPError as error:
                last_error = error
                if error.code not in retryable_statuses or attempt == self.max_attempts:
                    provider_message = self._safe_error_message(
                        error,
                        secret_values=tuple(secret_parameters.values()),
                    )
                    message_suffix = (
                        f'; provider_message={provider_message}' if provider_message else ''
                    )
                    raise ProviderHttpError(
                        f'{provider} HTTP {error.code}; endpoint={endpoint}; '
                        f'request_sha256={request_sha256}{message_suffix}'
                    ) from error
                retry_after = error.headers.get('Retry-After') if error.headers else None
                delay = self._retry_delay(attempt, retry_after)
            except (urllib.error.URLError, TimeoutError) as error:
                last_error = error
                if attempt == self.max_attempts:
                    reason = error.reason if isinstance(error, urllib.error.URLError) else error
                    reason_text = str(reason)
                    for secret in secret_parameters.values():
                        if secret:
                            reason_text = reason_text.replace(secret, '[REDACTED]')
                    raise ProviderHttpError(
                        f'{provider} network failure; endpoint={endpoint}; '
                        f'request_sha256={request_sha256}; '
                        f'reason={type(reason).__name__}: {reason_text[:500]}'
                    ) from error
                delay = self._retry_delay(attempt, None)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ProviderResponseError(
                    f'{provider} returned invalid UTF-8 JSON; request_sha256={request_sha256}'
                ) from error
            self.sleeper(delay)
        raise ProviderHttpError(f'Unreachable retry state: {last_error}')

    @staticmethod
    def _reject_json_constant(value: str, request_sha256: str) -> None:
        raise ProviderResponseError(
            f'Provider returned non-standard JSON constant {value}; '
            f'request_sha256={request_sha256}'
        )

    @staticmethod
    def _retry_delay(attempt: int, retry_after: str | None) -> float:
        if retry_after is not None:
            try:
                return min(max(float(retry_after), 0.0), 30.0)
            except ValueError:
                pass
        return float(min(2 ** (attempt - 1), 30))

    def _safe_error_message(
        self,
        error: urllib.error.HTTPError,
        *,
        secret_values: tuple[str, ...],
    ) -> str:
        """Extract a bounded provider error without ever returning credentials."""
        try:
            raw = error.read(min(self.max_response_bytes + 1, 64 * 1024))
        except (OSError, ValueError):
            return ''
        if not raw:
            return ''
        text = raw.decode('utf-8', errors='replace')
        for secret in secret_values:
            if secret:
                text = text.replace(secret, '[REDACTED]')
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            return 'non-JSON error body'
        if not isinstance(payload, dict):
            return 'non-object JSON error body'
        parts = []
        for key in ('code', 'message', 'error'):
            value = payload.get(key)
            if isinstance(value, (str, int, float, bool)):
                parts.append(f'{key}={value}')
        return ', '.join(parts)[:1000]

    @staticmethod
    def _from_cached(cached: CachedResponse) -> JsonResponse:
        return JsonResponse(
            payload=cached.response,
            request_sha256=cached.request_sha256,
            response_sha256=cached.response_sha256,
            fetched_at=cached.fetched_at,
            cache_hit=True,
            http_status=cached.http_status,
        )
