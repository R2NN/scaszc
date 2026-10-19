"""Cold/warm real routing evidence, with independent disposable response caches."""
from __future__ import annotations
import json
import os
import sys
import time
from pathlib import Path
from datetime import datetime
from uuid import uuid4
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client
from beeline_routing.models import Coordinate, TransportMode
from beeline_routing.export import detailed_route_dict


def run(payload):
    directory=Path('/app/runtime/ui-shared-cache/transport-benchmarks')/uuid4().hex
    directory.mkdir(parents=True)
    result={'mode':payload['mode'],'timezone':'Europe/Moscow','contextEvents':[e['id'] for e in payload['events']],
            'cacheIsolation':'Separate new before/after SQLite caches; the warm run reuses only the after cache'}
    for label,events in [('before',[]),('after',payload['events'])]:
        os.environ['BEEGO_TRANSPORT_CONTEXT_JSON']=json.dumps(events)
        cache=RoutingCache(directory/f'{label}.sqlite3')
        client=create_route_client(cache,'valhalla-local-transit',timeout_seconds=25,max_attempts=1,
                                   transit_index=Path('/app/data/transit/moscow_2026-08-17.sqlite'),metro_wait_seconds=180)
        measurements=[]
        for iteration in range(2 if label=='after' else 1):
            entries_before=cache.status().response_count
            start=time.perf_counter()
            route=client.route(origin=Coordinate('benchmark-origin',*payload['origin']),
                               destination=Coordinate('benchmark-destination',*payload['destination']),
                               departure_at=datetime.fromisoformat(payload['departure']),mode=TransportMode(payload['mode']))
            elapsed=time.perf_counter()-start
            measurements.append({'secondsToFirstVerifiedResult':round(elapsed,3),'secondsToCompletion':round(elapsed,3),
                'status':route.status.value,'minutes':route.duration_minutes,'meters':route.distance_m,
                'cacheEntriesBefore':entries_before,'cacheEntriesAfter':cache.status().response_count,
                'providerReportsCacheHit':route.provenance.cache_hit})
        result[label]={'measurements':measurements,'route':detailed_route_dict(route)}
        if hasattr(client,'close'):client.close()
    result['geometryChanged']=result['before']['route']['geometry']!=result['after']['route']['geometry']
    return result


if __name__=='__main__':
    try: print(json.dumps(run(json.load(sys.stdin)),ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error':str(error)},ensure_ascii=False));sys.exit(1)
