"""Soft customer choices among identical, already validated route profiles."""
from __future__ import annotations

from dataclasses import replace
from ortools.graph.python import min_cost_flow

from beeline_planning import validate_initial_plan


def apply_customer_preferences(dataset, plan, candidates, requests, locked, profile, floor=1, ceiling=5):
    """Keep every visit and its road evidence; select only interchangeable crews."""
    if not requests:
        return plan, []
    eligible = {str(item['id']): item for item in candidates
                if floor <= item['rating']['score'] <= ceiling
                and item.get('available', True) and str(item['id']) in dataset.engineers
                and dataset.engineers[str(item['id'])].is_available}
    locked = set(locked) | {route.engineer_id for route in plan.engineer_plans if route.movements or route.dispatches}
    routes = [route for route in plan.engineer_plans if route.visits and route.engineer_id not in locked]
    options = [key for key in sorted(eligible) if key not in locked]
    by_job = {request['jobId']: request for request in requests}
    quality_bound = sum(len(route.visits) for route in routes) * 50000 + 1
    preferred_weight = quality_bound
    avoid_weight = (len(requests) + 1) * preferred_weight
    flow = min_cost_flow.SimpleMinCostFlow()
    source = 0
    target = 1 + len(routes) + len(options)
    arcs = {}
    for index, route in enumerate(routes):
        node = 1 + index
        flow.add_arc_with_capacity_and_unit_cost(source, node, 1, 0)
        original = dataset.engineers[route.engineer_id]
        for offset, key in enumerate(options):
            if profile(original) != profile(dataset.engineers[key]):
                continue
            wanted = avoided = 0
            for visit in route.visits:
                request = by_job.get(visit.job_id, {})
                wanted += eligible[key]['rating']['score'] >= 4.2 and key in request.get('preferredEngineerIds', [])
                avoided += key in request.get('avoidEngineerIds', [])
            cost = avoided * avoid_weight - wanted * preferred_weight - round(eligible[key]['rating']['score'] * 10000) * len(route.visits)
            arc = flow.add_arc_with_capacity_and_unit_cost(node, 1 + len(routes) + offset, 1, cost)
            arcs[arc] = (index, key)
    for offset in range(len(options)):
        flow.add_arc_with_capacity_and_unit_cost(1 + len(routes) + offset, target, 1, 0)
    flow.set_node_supply(source, len(routes))
    flow.set_node_supply(target, -len(routes))
    changed = plan
    if routes and flow.solve() == flow.OPTIMAL:
        selected = {index: key for arc, (index, key) in arcs.items() if flow.flow(arc)}
        if len(selected) == len(routes):
            replacements = {route.engineer_id: replace(route, engineer_id=selected[index]) for index, route in enumerate(routes)}
            trial = replace(plan, engineer_plans=tuple(replacements.get(route.engineer_id, route) for route in plan.engineer_plans))
            if validate_initial_plan(dataset, trial).is_valid:
                changed = trial
    assigned = {visit.job_id: route.engineer_id for route in changed.engineer_plans for visit in route.visits}
    route_for_job = {visit.job_id: route for route in plan.engineer_plans for visit in route.visits}
    report = []
    for request in requests:
        key = assigned.get(request['jobId'])
        wanted = request.get('preferredEngineerIds', [])
        avoided = request.get('avoidEngineerIds', [])
        route = route_for_job.get(request['jobId'])
        compatible = [item for item in options if route and profile(dataset.engineers[item]) == profile(dataset.engineers[route.engineer_id])]
        if key is None:
            status, reason = 'unassigned', 'Заявка не назначена в исходном плане; пожелание не ухудшает покрытие.'
        elif key in avoided:
            status = 'unavoidable'
            reason = 'Ручное закрепление или обязательство защищено.' if key in locked else 'Нет безопасной замены в подтверждённом составе: сохраняем назначения, окна и маршруты.'
        elif wanted and key in wanted and eligible.get(key, {}).get('rating', {}).get('score', 0) >= 4.2:
            status, reason = 'preferred', 'Знакомый специалист назначен без изменения времени визитов и покрытия.'
        elif wanted:
            status = 'not_applied'
            if key in locked:
                reason = 'Ручное закрепление или обязательство защищено.'
            elif not any(eligible.get(item, {}).get('rating', {}).get('score', 0) >= 4.2 for item in wanted):
                reason = 'Знакомый специалист недоступен, вне подтверждённого состава или ниже порога высокого рейтинга 4,2★.'
            elif not any(item in compatible for item in wanted):
                reason = 'У знакомого специалиста другой старт, территория, график, транспорт или оснащение; безопасная взаимозамена не подтверждена.'
            else:
                reason = 'Выбран состав с меньшим числом неудачных повторов и конфликтов пожеланий других клиентов.'
        else:
            status, reason = 'avoided', 'Повтор после 1★ исключён без потери назначений и изменения времени визитов.'
        report.append({**request, 'engineerId': key, 'status': status, 'reason': reason})
    return changed, report
