import gzip
from dataclasses import replace
from pathlib import Path

from beeline_planning import load_planning_dataset, validate_initial_plan, build_candidate_index
from beeline_planning.export import load_exact_plan_artifact

ROOT = Path(__file__).resolve().parents[2]
FOLDER = ROOT / 'algorithm/artifacts/tz3/home-starts'


def test_two_home_fixture_improves_coverage_with_unchanged_staff_and_job_constraints(tmp_path):
    dataset = load_planning_dataset(FOLDER / 'dataset', 'core')
    original = load_planning_dataset(ROOT / 'data/object-complexity/dataset', 'core')
    plan_file = tmp_path / 'initial-exact.json'
    plan_file.write_bytes(gzip.decompress((FOLDER / 'initial-exact.json.gz').read_bytes()))
    plan, raw = load_exact_plan_artifact(plan_file, dataset.dataset_sha256)
    report = validate_initial_plan(dataset, plan)
    assert report.is_valid, report.violations
    assert report.metrics.served_normal_jobs + report.metrics.served_urgent_jobs == 204
    assert plan.unserved_job_ids == ('SOUTHCENTER-23637',)
    assert not build_candidate_index(dataset).eligible_engineers_by_job['SOUTHCENTER-23637']
    assert dataset.jobs == original.jobs
    changed = []
    for key, engineer in dataset.engineers.items():
        previous = original.engineers[key]
        assert replace(engineer, start_office_id=previous.start_office_id) == previous
        if engineer.start_office_id != previous.start_office_id:
            changed.append(key)
    assert sorted(changed) == ['SOUTHCENTER-ENG-04', 'SOUTHEAST-ENG-04']
