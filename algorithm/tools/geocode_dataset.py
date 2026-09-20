from __future__ import annotations

import argparse
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

import pandas as pd


USER_AGENT = 'LCT-Hackathon-Dataset-Preparation/2.0 (one-time cached geocoding)'
ENDPOINT = 'https://nominatim.openstreetmap.org/search'


def normalize_address(value: str) -> str:
    text = value.strip()
    replacements = {
        'г.Город Москва': 'Москва',
        'г. Город Москва': 'Москва',
        'Город Москва': 'Москва',
        'г.Москва': 'Москва',
        'г. Москва': 'Москва',
        'МО, г. ': 'Московская область, ',
        'МО, г.': 'Московская область, ',
    }
    for source, target in replacements.items():
        text = text.replace(source, target)
    street_patterns = (
        (r'б-р\.([^,]+)', r'\1 бульвар'),
        (r'наб\.([^,]+)', r'\1 набережная'),
        (r'пер\.([^,]+)', r'\1 переулок'),
        (r'пр-кт\.([^,]+)', r'\1 проспект'),
        (r'пр-зд\.([^,]+)', r'\1 проезд'),
        (r'проезд\.([^,]+)', r'\1 проезд'),
        (r'ул\.([^,]+)', r'\1 улица'),
        (r'ш\.([^,]+)', r'\1 шоссе'),
    )
    for pattern, replacement in street_patterns:
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
    text = re.sub(r',\s*д\.\s*', ', ', text, flags=re.IGNORECASE)
    text = re.sub(r'\s+к\s*(\d+)', r'к\1', text, flags=re.IGNORECASE)
    text = re.sub(r'\s+стр\.\s*(\d+)', r'с\1', text, flags=re.IGNORECASE)
    text = re.sub(r'\s+', ' ', text)
    text = re.sub(r',\s*,+', ',', text)
    return text


def classify(result: dict[str, Any]) -> str:
    address = result.get('address') or {}
    if address.get('house_number'):
        return 'BUILDING'
    if result.get('addresstype') in {'building', 'house', 'apartments'}:
        return 'BUILDING'
    if address.get('road') or result.get('addresstype') == 'road':
        return 'STREET'
    if result:
        return 'LOCALITY'
    return 'UNRESOLVED'


def choose_result(results: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not results:
        return None
    ranks = {'BUILDING': 0, 'STREET': 1, 'LOCALITY': 2, 'UNRESOLVED': 3}
    return min(
        results,
        key=lambda item: (
            ranks[classify(item)],
            -float(item.get('importance') or 0),
            -int(item.get('place_rank') or 0),
        ),
    )


def request_address(address: str) -> dict[str, Any]:
    params = urllib.parse.urlencode(
        {
            'q': normalize_address(address),
            'format': 'jsonv2',
            'addressdetails': 1,
            'limit': 5,
            'countrycodes': 'ru',
            'accept-language': 'ru',
        }
    )
    request = urllib.request.Request(
        f'{ENDPOINT}?{params}',
        headers={'User-Agent': USER_AGENT},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        results = json.load(response)
    selected = choose_result(results)
    if selected is None:
        return {
            'query': normalize_address(address),
            'status': 'UNRESOLVED',
            'candidates': [],
        }
    lat = float(selected['lat'])
    lon = float(selected['lon'])
    inside_region = 53.8 <= lat <= 56.7 and 35.0 <= lon <= 40.5
    status = classify(selected) if inside_region else 'OUT_OF_REGION'
    return {
        'query': normalize_address(address),
        'status': status,
        'lat': lat,
        'lon': lon,
        'display_name': selected.get('display_name'),
        'osm_type': selected.get('osm_type'),
        'osm_id': selected.get('osm_id'),
        'place_rank': selected.get('place_rank'),
        'importance': selected.get('importance'),
        'licence': selected.get('licence'),
        'selected_address': selected.get('address') or {},
        'candidates': [
            {
                'lat': item.get('lat'),
                'lon': item.get('lon'),
                'display_name': item.get('display_name'),
                'status': classify(item),
                'osm_type': item.get('osm_type'),
                'osm_id': item.get('osm_id'),
            }
            for item in results
        ],
    }


def collect_addresses(dataset_root: Path) -> list[str]:
    values: set[str] = set()
    for scenario in ('core', 'stress'):
        jobs = pd.read_csv(
            dataset_root / scenario / 'jobs.csv',
            sep=';',
            encoding='utf-8-sig',
            dtype=str,
        ).fillna('')
        values.update(value for value in jobs['address'] if value)
    offices = pd.read_csv(
        dataset_root / 'common' / 'offices.csv',
        sep=';',
        encoding='utf-8-sig',
        dtype=str,
    ).fillna('')
    values.update(value for value in offices['address'] if value)
    return sorted(values)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('dataset_root', type=Path)
    parser.add_argument('cache_file', type=Path)
    args = parser.parse_args()
    addresses = collect_addresses(args.dataset_root)
    cache: dict[str, Any] = {}
    if args.cache_file.exists():
        cache = json.loads(args.cache_file.read_text(encoding='utf-8'))
    args.cache_file.parent.mkdir(parents=True, exist_ok=True)

    pending = [
        address
        for address in addresses
        if address not in cache
        or cache[address].get('query') != normalize_address(address)
    ]
    print(f'total={len(addresses)} cached={len(addresses) - len(pending)} pending={len(pending)}', flush=True)
    for index, address in enumerate(pending, start=1):
        try:
            cache[address] = request_address(address)
        except Exception as error:  # Network errors remain explicit and retryable.
            cache[address] = {
                'query': normalize_address(address),
                'status': 'REQUEST_ERROR',
                'error': f'{type(error).__name__}: {error}',
            }
        args.cache_file.write_text(
            json.dumps(cache, ensure_ascii=False, indent=2),
            encoding='utf-8',
        )
        if index % 20 == 0 or index == len(pending):
            counts: dict[str, int] = {}
            for entry in cache.values():
                status = entry.get('status', 'UNKNOWN')
                counts[status] = counts.get(status, 0) + 1
            print(f'progress={index}/{len(pending)} statuses={counts}', flush=True)
        if index < len(pending):
            time.sleep(1.1)


if __name__ == '__main__':
    main()
