from __future__ import annotations

import argparse
import json
from pathlib import Path

from beeline_routing.export import payload_sha256, write_json_atomic


def main() -> int:
    """Extract the latest screening candidate from a refinement checkpoint."""
    parser = argparse.ArgumentParser(
        description='Extract a checksummed master solution from a refinement checkpoint.',
    )
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()

    payload = json.loads(args.checkpoint.read_text(encoding='utf-8'))
    if not isinstance(payload, dict):
        parser.error('Checkpoint root must be an object')
    unsigned = dict(payload)
    expected_hash = unsigned.pop('content_sha256', None)
    if expected_hash != payload_sha256(unsigned):
        parser.error('Checkpoint content checksum mismatch')
    if payload.get('artifact_type') != 'EXACT_REFINEMENT_LOOP_CHECKPOINT':
        parser.error('Input is not a refinement checkpoint')
    candidate = payload.get('latest_candidate')
    if not isinstance(candidate, dict):
        parser.error('Checkpoint has no latest candidate')
    candidate = dict(candidate)
    candidate['content_sha256'] = payload_sha256(candidate)
    write_json_atomic(args.output, candidate)
    print(json.dumps({
        'status': candidate.get('status'),
        'served_jobs': candidate.get('summary', {}).get('served_jobs'),
        'unserved_jobs': candidate.get('summary', {}).get('unserved_jobs'),
        'output': str(args.output),
    }, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
