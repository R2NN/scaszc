from pathlib import Path
import argparse
import json
import sys

parser = argparse.ArgumentParser(description='Validate authoritative duration snapshots and dataset constraints')
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent)
parser.add_argument('--write-reports', action='store_true', help='Accepted for compatibility; this validator does not mutate checksummed input')
args = parser.parse_args()
repository = next(parent for parent in Path(__file__).resolve().parents if (parent / 'algorithm' / 'src').is_dir())
sys.path.insert(0, str(repository / 'algorithm' / 'src'))
from beeline_planning import load_planning_dataset
results = []
for scenario in ('core', 'stress'):
    data = load_planning_dataset(args.root, scenario)
    results.append({'scenario': scenario, 'jobs': len(data.jobs), 'dataset_sha256': data.dataset_sha256, 'status': 'VALID'})
print(json.dumps({'status': 'VALID', 'results': results}))
