from __future__ import annotations

import argparse
import json
from pathlib import Path

from beeline_planning import build_candidate_index, load_planning_dataset
from beeline_routing.export import payload_sha256, write_json_atomic


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            'Validate any dataset that follows the planning schema 2.1.0 without '
            'assuming the canonical date, zones, IDs, or row counts.'
        )
    )
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument(
        '--scenario', action='append', choices=('core', 'stress'),
        help='Scenario to validate; repeat for both. Defaults to core and stress.',
    )
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    scenarios = tuple(dict.fromkeys(args.scenario or ('core', 'stress')))

    summaries = []
    dataset_sha256 = None
    for scenario in scenarios:
        dataset = load_planning_dataset(args.dataset, scenario)
        if dataset_sha256 is None:
            dataset_sha256 = dataset.dataset_sha256
        elif dataset.dataset_sha256 != dataset_sha256:
            raise ValueError('Scenarios were not loaded from one checksummed dataset')
        candidates = build_candidate_index(dataset)
        active_initial = dataset.active_jobs_at(dataset.initial_planning_at)
        candidate_counts = [
            len(candidates.eligible_engineers_by_job[job.job_id])
            for job in active_initial
        ]
        summaries.append({
            'scenario': scenario,
            'planning_date': dataset.planning_date,
            'initial_planning_at': dataset.initial_planning_at.isoformat(),
            'timezone': dataset.timezone_name,
            'zones': sorted({item.zone_id for item in dataset.engineers.values()}),
            'engineers': len(dataset.engineers),
            'available_engineers': sum(
                engineer.is_available for engineer in dataset.engineers.values()
            ),
            'jobs_total': len(dataset.jobs),
            'jobs_active_initially': len(active_initial),
            'urgent_jobs_active_initially': sum(
                job.priority.value == 'URGENT' for job in active_initial
            ),
            'events': len(dataset.events),
            'commitments': len(dataset.commitments),
            'locations': len(dataset.locations),
            'static_candidate_count': {
                'minimum': min(candidate_counts, default=0),
                'maximum': max(candidate_counts, default=0),
                'jobs_without_candidate': sum(count == 0 for count in candidate_counts),
            },
            'event_order': [
                {
                    'event_id': event.event_id,
                    'apply_order': event.apply_order,
                    'event_time': event.event_time.isoformat(),
                    'event_type': event.event_type.value,
                }
                for event in dataset.events
            ],
        })

    payload = {
        'artifact_type': 'GENERIC_PLANNING_DATASET_VALIDATION',
        'status': 'VALID',
        'dataset_root': str(args.dataset.resolve()),
        'dataset_sha256': dataset_sha256,
        'schema_version': '2.1.0',
        'scenario_summaries': summaries,
        'canonical_dataset_assumptions_used': False,
    }
    payload['content_sha256'] = payload_sha256(payload)
    if args.output is not None:
        if args.output.exists():
            parser.error('Output already exists; use a new validation path')
        write_json_atomic(args.output, payload)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
