from __future__ import annotations

import argparse
import json
from pathlib import Path

from beeline_planning import (
    build_explanation_bundle,
    load_planning_dataset,
    validate_initial_plan,
)
from beeline_planning.export import load_exact_plan_artifact
from beeline_routing.export import payload_sha256, write_json_atomic


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Add auditable structured explanations to a published initial exact plan.'
    )
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--scenario', choices=('core', 'stress'), required=True)
    parser.add_argument('--input-plan', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.resolve() == args.input_plan.resolve() or args.output.exists():
        parser.error('Output must be a new path; source plans are never overwritten')

    dataset = load_planning_dataset(args.dataset, args.scenario)
    plan, source = load_exact_plan_artifact(args.input_plan, dataset.dataset_sha256)
    if source.get('replanning_state') is not None:
        parser.error('Use explanations already emitted by replan_exact_plan.py for event plans')
    validation = validate_initial_plan(dataset, plan)
    if not validation.is_valid:
        raise ValueError(f'Source plan failed validation: {validation.violations}')

    payload = {key: value for key, value in source.items() if key != 'content_sha256'}
    payload['explanations'] = build_explanation_bundle(
        dataset,
        plan,
        validation,
        insertion_diagnostics=source.get('unserved_insertion_diagnostics', {}),
        search_budget_exhausted=bool(source.get('search_budget_exhausted', False)),
        exact_route_checks=source.get('exact_route_checks'),
        exact_provider_queries=source.get('exact_provider_queries'),
        global_optimality_proven=bool(source.get('global_optimality_proven', False)),
    )
    payload['explanation_source'] = {
        'source_plan': str(args.input_plan),
        'source_plan_content_sha256': source['content_sha256'],
        'generator': 'beeline_planning.explanations/1.0.0',
    }
    payload['content_sha256'] = payload_sha256(payload)
    write_json_atomic(args.output, payload)
    print(json.dumps({
        'status': payload['status'],
        'publication_allowed': payload['publication_allowed'],
        'explained_jobs': len(payload['explanations']['jobs']),
        'output': str(args.output),
    }, ensure_ascii=False), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
