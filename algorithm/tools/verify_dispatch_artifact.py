"""Reopen a dispatch artifact and validate the full shift outside the search process."""
from __future__ import annotations

import argparse
import json
from dataclasses import replace
from datetime import datetime
from pathlib import Path

from beeline_planning import load_planning_dataset, validate_replanned_plan
from beeline_planning.domain import EventType
from beeline_planning.export import load_exact_plan_artifact
from beeline_planning.plan import IdentityTravel
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client
from beeline_routing.export import write_json_atomic
from beeline_routing.oracle import ExactRoutingOracle, OracleQuery
from replan_ui_event import _event_dataset


def verify(artifact, dataset_path, root, oracle=None):
    """Check all constraints and optionally requery every route in a fresh cache."""
    raw=json.loads(artifact.read_text(encoding='utf-8'))
    dataset=load_planning_dataset(dataset_path,'core')
    events=[]
    previous=dataset
    for item in raw['ui_history']:
        previous=dataset
        dataset,event=_event_dataset(dataset,item)
        event=replace(event,apply_order=len(events)+1)
        events.append(event)
        dataset=replace(dataset,events=tuple(events))
    source_hash=raw['source_plan_content_sha256']
    sources=[root/'algorithm/artifacts/complexity/initial-exact.json',root/'runtime/exact-replans'/f'{source_hash}.json']
    source_file=next(path for path in sources if path.exists() and json.loads(path.read_text(encoding='utf-8'))['content_sha256']==source_hash)
    old,_=load_exact_plan_artifact(source_file,previous.dataset_sha256)
    plan,_=load_exact_plan_artifact(artifact,dataset.dataset_sha256)
    unavailable={}
    for event in events:
        if event.event_type==EventType.ENGINEER_UNAVAILABLE: unavailable[event.target_id]=event.unavailable_until
        elif event.event_type==EventType.CAPACITY_ADDED: unavailable.pop(event.target_id,None)
    report=validate_replanned_plan(dataset,plan,old,event_time=events[-1].event_time,applied_event_ids=frozenset(e.event_id for e in events),canceled_job_ids=frozenset(e.target_id for e in events if e.event_type==EventType.CANCEL_JOB),unavailable_until_by_engineer=unavailable)
    trips=[]
    if oracle:
        for route in plan.engineer_plans:
            for visit in route.visits:
                travel=visit.travel
                if isinstance(travel,IdentityTravel): continue
                actual=oracle.query(OracleQuery(dataset.engineers[route.engineer_id].transport_mode,dataset.locations[travel.origin_id],dataset.locations[travel.destination_id],visit.departure_at),refresh=False)
                trips.append({'engineerId':route.engineer_id,'jobId':visit.job_id,'mode':actual.mode.value,'departureAt':visit.departure_at.isoformat(),'durationMinutes':actual.duration_minutes,'distanceM':actual.distance_m,'matches':actual.status.value=='OK' and actual.duration_minutes==travel.duration_minutes and actual.distance_m==travel.distance_m,'responseSha256':actual.provenance.response_sha256})
                if len(trips)%25==0: print(json.dumps({'artifact':raw['content_sha256'],'checked':len(trips)}),flush=True)
    return {'artifact':str(artifact),'contentSha256':raw['content_sha256'],'datasetSha256':dataset.dataset_sha256,'status':report.status.value,'violations':[{'code':v.code.value,'subject':v.subject_id,'detail':v.detail} for v in report.violations],'recomputedMetrics':{'waitingMinutes':report.metrics.total_waiting_minutes,'travelMinutes':report.metrics.total_travel_minutes,'distanceM':report.metrics.total_distance_m},'freshRoadChecks':len(trips),'roadDifferences':sum(not trip['matches'] for trip in trips),'trips':trips}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--artifact',type=Path,action='append',required=True)
    parser.add_argument('--dataset',type=Path,required=True)
    parser.add_argument('--root',type=Path,default=Path(__file__).parents[2])
    parser.add_argument('--cache',type=Path)
    parser.add_argument('--transit-index',type=Path)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    oracle=None
    if args.cache:
        if args.cache.exists(): raise ValueError('Independent run requires a new empty cache path')
        oracle=ExactRoutingOracle(create_route_client(RoutingCache(args.cache),'valhalla-local-transit',timeout_seconds=30,max_attempts=2,transit_index=args.transit_index,metro_wait_seconds=180))
    reports=[verify(file,args.dataset,args.root,oracle) for file in args.artifact]
    write_json_atomic(args.output,{'verifiedAt':datetime.now().astimezone().isoformat(),'reports':reports})
    print(json.dumps([{'sha':r['contentSha256'],'status':r['status'],'roads':r['freshRoadChecks'],'differences':r['roadDifferences']} for r in reports]))
    return 0 if all(r['status']=='VALID' and r['roadDifferences']==0 for r in reports) else 1


if __name__=='__main__':
    raise SystemExit(main())
