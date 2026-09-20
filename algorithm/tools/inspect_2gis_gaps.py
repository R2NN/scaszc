from __future__ import annotations

import argparse
import ast
import json
import re
import subprocess
import tempfile
import time
import urllib.parse
from pathlib import Path
from typing import Any


USER_AGENT = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/140.0.0.0 Safari/537.36'
)
SEARCH_URL = 'https://2gis.ru/moscow/search/'
INITIAL_STATE_PATTERN = re.compile(
    r"var initialState = JSON\.parse\('(.*?)'\);",
    flags=re.DOTALL,
)


SEARCH_QUERIES: dict[str, str] = {
    'Город Москва, ул.Академика Миллионщикова, д. 13 к 1': 'Москва, улица Академика Миллионщикова, 13 к1',
    'Город Москва, ул.Дубининская, д. 59 к 2': 'Москва, Дубининская улица, 59 к2',
    'Город Москва, ул.Красноказарменная, д. 9Б стр. 1': 'Москва, Красноказарменная улица, 9Б строение 1',
    'Город Москва, ул.Машкова, д. 13 стр. 1': 'Москва, улица Машкова, 13 строение 1',
    'Город Москва, ул.Москворечье, д. 4 к 6': 'Москва, улица Москворечье, 4 к6',
    'Домодедово, ул.Гагарина, д. 55/2': 'Домодедово, улица Гагарина, 55/2',
    'МО, г. Кашира Кржижановского ул. д. 5/1': 'Кашира, улица Кржижановского, 5/1',
    'МО, г. Кашира Кржижановского ул. д. 5/2': 'Кашира, улица Кржижановского, 5/2',
    'МО, г. Кашира Кржижановского ул. д. 5/3': 'Кашира, улица Кржижановского, 5/3',
    'МО, г. Кашира Кржижановского ул. д. 7к2': 'Кашира, улица Кржижановского, 7 к2',
    'Москва Булатниковский пр-зд. д. 6к1': 'Москва, Булатниковский проезд, 6 к1',
    'г. Москва, ул. Бирюлёвская, д. 1, стр. 1': 'Москва, Бирюлёвская улица, 1 строение 1',
    'г. Москва, ул. Юных Ленинцев, д. 83, стр. 4': 'Москва, улица Юных Ленинцев, 83 строение 4',
}


def extract_initial_state(html: str) -> dict[str, Any]:
    match = INITIAL_STATE_PATTERN.search(html)
    if not match:
        raise ValueError('2GIS initial state was not found')
    javascript_string = ast.literal_eval("'" + match.group(1) + "'")
    return json.loads(javascript_string)


def find_candidates(state: dict[str, Any]) -> list[dict[str, Any]]:
    profiles = state['data']['entity']['profile']
    candidates: list[dict[str, Any]] = []
    for profile in profiles.values():
        data = profile.get('data') or {}
        point = data.get('point') or {}
        address = data.get('address') or {}
        if point.get('lat') is None or point.get('lon') is None:
            continue
        if not address.get('building_id'):
            continue
        candidates.append(
            {
                'object_id': data.get('id'),
                'address_name': data.get('address_name'),
                'full_name': data.get('full_name'),
                'latitude': point['lat'],
                'longitude': point['lon'],
                'purpose_name': data.get('purpose_name'),
                'postcode': address.get('postcode'),
            }
        )
    return candidates


def fetch_html(url: str) -> str:
    with tempfile.NamedTemporaryFile(delete=False, suffix='.html') as file:
        temporary_path = Path(file.name)
    try:
        subprocess.run(
            [
                'curl.exe',
                '--compressed',
                '--fail',
                '--silent',
                '--show-error',
                '--max-time',
                '30',
                '--user-agent',
                USER_AGENT,
                '--output',
                str(temporary_path),
                url,
            ],
            check=True,
        )
        return temporary_path.read_text(encoding='utf-8')
    finally:
        temporary_path.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('output_file', type=Path)
    args = parser.parse_args()
    output: dict[str, Any] = {}
    for index, (source_address, query) in enumerate(SEARCH_QUERIES.items(), start=1):
        url = SEARCH_URL + urllib.parse.quote(query, safe='')
        html = fetch_html(url)
        candidates = find_candidates(extract_initial_state(html))
        output[source_address] = {
            'query': query,
            'source_url': url,
            'candidates': candidates,
        }
        print(f'{index}/{len(SEARCH_QUERIES)} {query}: {len(candidates)} candidate(s)', flush=True)
        if index < len(SEARCH_QUERIES):
            time.sleep(1.0)
    args.output_file.write_text(
        json.dumps(output, ensure_ascii=False, indent=2),
        encoding='utf-8',
    )


if __name__ == '__main__':
    main()
