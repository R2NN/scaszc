"""Read immutable server snapshots without a second duration formula."""
from __future__ import annotations

import hashlib
import json
from typing import Any

from .errors import InvalidPlanningData


def verify_duration_snapshot(snapshot: dict[str, Any], minutes: int) -> tuple[int, str]:
    """Independently verify content identity, units, version and applied minutes."""
    if not isinstance(snapshot, dict):
        raise InvalidPlanningData('Missing duration snapshot')
    identity = snapshot.get('id')
    content = {key: value for key, value in snapshot.items() if key != 'id'}
    encoded = json.dumps(content, ensure_ascii=False, separators=(',', ':'))
    expected = hashlib.sha256(encoded.encode('utf-8')).hexdigest()
    total = snapshot.get('total')
    if identity != expected or type(total) is not int or total < 1 or total != minutes:
        raise InvalidPlanningData('Duration differs from authoritative server snapshot')
    if not snapshot.get('modelVersion') or snapshot.get('units') != 'minutes' or snapshot.get('travelIncluded') is not False:
        raise InvalidPlanningData('Unsupported duration contract')
    return total, identity
