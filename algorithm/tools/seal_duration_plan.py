"""Rebind retained road evidence only when durations agree, then validate again."""
from __future__ import annotations

import argparse
from pathlib import Path

from beeline_planning import build_explanation_bundle, load_planning_dataset
from beeline_planning.export import load_exact_plan_artifact
from beeline_planning.validator import validate_initial_plan
from beeline_routing.export import payload_sha256, write_json_atomic


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dataset', type=Path, required=True)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--input-plan', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source = load_planning_dataset(args.source_dataset, 'core')
    target = load_planning_dataset(args.dataset, 'core')
    if {key: job.service_duration_min for key, job in source.jobs.items()} != {
        key: job.service_duration_min for key, job in target.jobs.items()
    }:
        raise ValueError('Durations changed: exact materialization is required')
    plan, raw = load_exact_plan_artifact(args.input_plan, source.dataset_sha256)
    report = validate_initial_plan(target, plan)
    if not report.is_valid:
        raise ValueError(f'Independent validation failed: {report.violations}')
    raw.pop('content_sha256')
    raw['dataset_sha256'] = target.dataset_sha256
    raw['explanations'] = build_explanation_bundle(
        target, plan, report, exact_provider_queries=raw.get('exact_provider_queries', 0),
        global_optimality_proven=False,
    )
    raw['snapshot_reseal'] = {
        'source_dataset_sha256': source.dataset_sha256,
        'reason': 'Snapshot evidence metadata updated; all durations agree; independent validation repeated; road proofs retained.',
    }
    raw['content_sha256'] = payload_sha256(raw)
    write_json_atomic(args.output, raw)
    print(raw['content_sha256'])


if __name__ == '__main__':
    main()
