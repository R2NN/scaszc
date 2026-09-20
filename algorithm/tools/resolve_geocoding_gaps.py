from __future__ import annotations

import argparse
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from geocode_dataset import ENDPOINT, USER_AGENT, choose_result, classify


QUERY_VARIANTS: dict[str, tuple[str, ...]] = {
    'Город Москва, пр-кт.60-летия Октября, д. 17': (
        'Москва, проспект 60-летия Октября, 17',
    ),
    'Город Москва, пр-кт.60-летия Октября, д. 18 к 2': (
        'Москва, проспект 60-летия Октября, 18 корпус 2',
        'Москва, проспект 60-летия Октября, 18к2',
    ),
    'Город Москва, ул.11-я Текстильщиков, д. 10': (
        'Москва, 11-я улица Текстильщиков, 10',
    ),
    'Город Москва, ул.Академика Миллионщикова, д. 13 к 1': (
        'Москва, улица Академика Миллионщикова, 13 корпус 1',
    ),
    'Город Москва, ул.Артюхиной, д. 20А': (
        'Москва, улица Артюхиной, 20А',
    ),
    'Город Москва, ул.Дубининская, д. 59 к 2': (
        'Москва, Дубининская улица, 59 корпус 2',
        'Москва, Дубининская улица, 59к2',
    ),
    'Город Москва, ул.Красноказарменная, д. 9Б стр. 1': (
        'Москва, Красноказарменная улица, 9Б строение 1',
        'Москва, Красноказарменная улица, 9Бс1',
    ),
    'Город Москва, ул.Машкова, д. 13 стр. 1': (
        'Москва, улица Машкова, 13 строение 1',
    ),
    'Город Москва, ул.Москворечье, д. 4 к 6': (
        'Москва, улица Москворечье, 4 корпус 6',
    ),
    'Город Москва, ул.Фёдора Полетаева, д. 2 к 6': (
        'Москва, улица Фёдора Полетаева, 2 корпус 6',
        'Москва, улица Федора Полетаева, 2к6',
    ),
    'Домодедово, проезд.Советский 1-й, д. 1А': (
        'Домодедово, 1-й Советский проезд, 1А',
    ),
    'Домодедово, ул.Гагарина, д. 55/2': (
        'Домодедово, улица Гагарина, 55/2',
    ),
    'МО, г. Кашира Кржижановского ул. д. 5/1': (
        'Московская область, Кашира, улица Кржижановского, 5/1',
    ),
    'МО, г. Кашира Кржижановского ул. д. 5/2': (
        'Московская область, Кашира, улица Кржижановского, 5/2',
    ),
    'МО, г. Кашира Кржижановского ул. д. 5/3': (
        'Московская область, Кашира, улица Кржижановского, 5/3',
    ),
    'МО, г. Кашира Кржижановского ул. д. 7к2': (
        'Московская область, Кашира, улица Кржижановского, 7 корпус 2',
    ),
    'МО, г. Ступино Андропова ул. д. 33': (
        'Московская область, Ступино, улица Андропова, 33',
    ),
    'МО, г. Ступино Андропова ул. д. 37': (
        'Московская область, Ступино, улица Андропова, 37',
    ),
    'Москва Бирюлевская ул. д. 44': (
        'Москва, Бирюлёвская улица, 44',
        'Москва, Бирюлевская улица, 44',
    ),
    'Москва Булатниковский пр-зд. д. 6к1': (
        'Москва, Булатниковский проезд, 6 корпус 1',
    ),
    'г. Москва, ул. Бирюлёвская, д. 1, стр. 1': (
        'Москва, Бирюлёвская улица, 1 строение 1',
    ),
    'г. Москва, ул. Юных Ленинцев, д. 83, стр. 4': (
        'Москва, улица Юных Ленинцев, 83 строение 4',
    ),
    'обл.Московская область, г.Домодедово, пгт.Востряково-1, ул.Жуковского, д. 14/18': (
        'Московская область, Домодедово, микрорайон Авиационный, улица Жуковского, 14/18',
        'Московская область, Домодедово, Востряково, улица Жуковского, 14/18',
    ),
}


def request_query(query: str) -> dict[str, Any]:
    params = urllib.parse.urlencode(
        {
            'q': query,
            'format': 'jsonv2',
            'addressdetails': 1,
            'limit': 10,
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
        return {'query': query, 'status': 'UNRESOLVED', 'candidates': []}
    lat = float(selected['lat'])
    lon = float(selected['lon'])
    inside_region = 53.8 <= lat <= 56.7 and 35.0 <= lon <= 40.5
    status = classify(selected) if inside_region else 'OUT_OF_REGION'
    return {
        'query': query,
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('cache_file', type=Path)
    args = parser.parse_args()
    cache = json.loads(args.cache_file.read_text(encoding='utf-8'))
    pending = [
        address
        for address, result in cache.items()
        if result.get('status') != 'BUILDING'
    ]
    unknown = sorted(set(pending) - set(QUERY_VARIANTS))
    if unknown:
        raise SystemExit(f'No explicit variants for: {unknown}')

    total_queries = sum(len(QUERY_VARIANTS[address]) for address in pending)
    completed = 0
    for address in pending:
        attempts: list[dict[str, Any]] = []
        for query in QUERY_VARIANTS[address]:
            result = request_query(query)
            attempts.append(dict(result))
            completed += 1
            print(
                f'{completed}/{total_queries} {result["status"]}: {query}',
                flush=True,
            )
            if result['status'] == 'BUILDING':
                result['resolution_method'] = 'EXPLICIT_QUERY_VARIANT'
                result['attempts'] = attempts
                cache[address] = result
                break
            if completed < total_queries:
                time.sleep(1.1)
        else:
            original = cache[address]
            original['resolution_attempts'] = attempts
            cache[address] = original
        args.cache_file.write_text(
            json.dumps(cache, ensure_ascii=False, indent=2),
            encoding='utf-8',
        )

    counts: dict[str, int] = {}
    for entry in cache.values():
        status = entry.get('status', 'UNKNOWN')
        counts[status] = counts.get(status, 0) + 1
    print(f'final_statuses={counts}', flush=True)


if __name__ == '__main__':
    main()
