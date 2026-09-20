from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum
from importlib.metadata import version
from typing import Iterable

from ortools.sat.python import cp_model

from .domain import Job, PlanningDataset, Priority
from .master import MasterArc, MasterModelInput


class MasterSolveStatus(StrEnum):
    SCREENING_OPTIMAL = 'SCREENING_OPTIMAL'
    SCREENING_RESTRICTED_OPTIMAL = 'SCREENING_RESTRICTED_OPTIMAL'
    SCREENING_FEASIBLE = 'SCREENING_FEASIBLE'
    SCREENING_INFEASIBLE = 'SCREENING_INFEASIBLE'
    NO_SOLUTION_WITHIN_LIMIT = 'NO_SOLUTION_WITHIN_LIMIT'


class ObjectivePolicy(StrEnum):
    """Business priority used after maximum feasible coverage is fixed."""

    SERVICE_QUALITY = 'SERVICE_QUALITY'
    COMPACT_TEAM = 'COMPACT_TEAM'


@dataclass(frozen=True, slots=True)
class SolverConfig:
    max_seconds_per_tier: float = 30.0
    random_seed: int = 20260915
    num_search_workers: int = 1
    log_search_progress: bool = False
    cp_model_presolve: bool = True
    max_presolve_iterations: int = 1
    presolve_probing_deterministic_time_limit: float = 0.1
    max_predecessors_per_destination: int | None = None
    excluded_arcs: tuple[tuple[str, str, str], ...] = ()
    objective_policy: ObjectivePolicy = ObjectivePolicy.COMPACT_TEAM
    require_full_coverage: bool = True
    full_coverage_seconds: float = 300.0
    allow_partial_after_proven_infeasible: bool = False
    fixed_unserved_by_priority: tuple[int, int] | None = None
    max_used_engineers: int | None = None

    def __post_init__(self) -> None:
        if self.max_seconds_per_tier <= 0:
            raise ValueError('max_seconds_per_tier must be positive')
        if self.full_coverage_seconds <= 0:
            raise ValueError('full_coverage_seconds must be positive')
        if self.num_search_workers < 1:
            raise ValueError('num_search_workers must be positive')
        if self.max_presolve_iterations < 1:
            raise ValueError('max_presolve_iterations must be positive')
        if (
            self.max_predecessors_per_destination is not None
            and self.max_predecessors_per_destination < 1
        ):
            raise ValueError('max_predecessors_per_destination must be positive')
        if (
            self.fixed_unserved_by_priority is not None
            and (
                len(self.fixed_unserved_by_priority) != 2
                or any(value < 0 for value in self.fixed_unserved_by_priority)
            )
        ):
            raise ValueError('fixed_unserved_by_priority must contain two non-negative counts')
        if self.fixed_unserved_by_priority is not None and self.require_full_coverage:
            raise ValueError('Fixed partial coverage requires require_full_coverage=False')
        if self.max_used_engineers is not None and self.max_used_engineers < 0:
            raise ValueError('max_used_engineers must be non-negative')


@dataclass(frozen=True, slots=True)
class ObjectiveProof:
    tier: int
    metric: str
    value: int
    best_bound: int
    proven_optimal: bool
    wall_time_seconds: float


@dataclass(frozen=True, slots=True)
class MasterVisit:
    sequence: int
    job_id: str
    origin_node_id: str
    departure_at: datetime
    service_start_at: datetime
    screening_duration_minutes: int
    screening_distance_m: int
    screening_source_mode: str
    screening_is_surrogate: bool


@dataclass(frozen=True, slots=True)
class MasterEngineerRoute:
    engineer_id: str
    visits: tuple[MasterVisit, ...]


@dataclass(frozen=True, slots=True)
class MasterSolution:
    status: MasterSolveStatus
    planning_at: datetime
    routes: tuple[MasterEngineerRoute, ...]
    unserved_job_ids: tuple[str, ...]
    objective_proofs: tuple[ObjectiveProof, ...]
    dataset_sha256: str
    screening_snapshot_sha256: str
    solver_version: str
    search_graph_complete: bool
    searched_arc_count: int
    operationally_excluded_arcs: tuple[tuple[str, str, str], ...]

    @property
    def all_tiers_proven(self) -> bool:
        return bool(self.objective_proofs) and all(
            proof.proven_optimal for proof in self.objective_proofs
        )


@dataclass(slots=True)
class _Variables:
    assignment: dict[tuple[str, str], cp_model.IntVar]
    unserved: dict[str, cp_model.IntVar]
    used: dict[str, cp_model.IntVar]
    arc: dict[tuple[str, str, str], cp_model.IntVar]
    finish: dict[tuple[str, str], cp_model.IntVar]
    service_start: dict[str, cp_model.IntVar]
    departure: dict[tuple[str, str], cp_model.IntVar]
    waiting: dict[tuple[str, str], cp_model.IntVar]
    route_start: dict[str, cp_model.IntVar]
    route_end: dict[str, cp_model.IntVar]
    route_load: dict[str, cp_model.IntVar]


@dataclass(slots=True)
class _BuiltModel:
    model: cp_model.CpModel
    variables: _Variables
    arcs_by_key: dict[tuple[str, str, str], MasterArc]
    objective_tiers: tuple[tuple[str, cp_model.LinearExpr], ...]
    search_graph_complete: bool
    operationally_excluded_arcs: tuple[tuple[str, str, str], ...]


def _minute(day_start: datetime, value: datetime) -> int:
    delta = value - day_start
    seconds = delta.total_seconds()
    if seconds % 60:
        raise ValueError(f'Timestamp must be a whole minute: {value.isoformat()}')
    return int(seconds // 60)


def _sum(values: Iterable[cp_model.LinearExpr]) -> cp_model.LinearExpr:
    return cp_model.LinearExpr.sum(list(values))


def _select_search_arcs(
    arcs: tuple[MasterArc, ...],
    max_predecessors: int | None,
    excluded_arcs: tuple[tuple[str, str, str], ...],
    preserved_arcs: frozenset[tuple[str, str, str]] = frozenset(),
) -> tuple[tuple[MasterArc, ...], bool]:
    excluded = set(excluded_arcs)
    available_keys = {
        (arc.engineer_id, arc.origin_node_id, arc.destination_job_id) for arc in arcs
    }
    unknown_exclusions = sorted(excluded - available_keys)
    if unknown_exclusions:
        raise ValueError(f'Excluded arcs are absent from the master graph: {unknown_exclusions}')
    filtered = tuple(
        arc
        for arc in arcs
        if (arc.engineer_id, arc.origin_node_id, arc.destination_job_id) not in excluded
    )
    if max_predecessors is None:
        return filtered, not excluded
    selected: list[MasterArc] = []
    grouped: dict[tuple[str, str], list[MasterArc]] = {}
    for arc in filtered:
        if arc.origin_node_id.startswith('START:'):
            selected.append(arc)
        else:
            grouped.setdefault((arc.engineer_id, arc.destination_job_id), []).append(arc)
    for key in sorted(grouped):
        choices = sorted(
            grouped[key],
            key=lambda item: (
                item.screening_duration_minutes,
                item.screening_distance_m,
                item.origin_node_id,
            ),
        )
        selected.extend(
            arc
            for index, arc in enumerate(choices)
            if index < max_predecessors
            or (arc.engineer_id, arc.origin_node_id, arc.destination_job_id)
            in preserved_arcs
        )
    selected.sort(
        key=lambda item: (item.engineer_id, item.origin_node_id, item.destination_job_id)
    )
    return tuple(selected), len(selected) == len(arcs)


def _build_cp_model(
    dataset: PlanningDataset,
    master: MasterModelInput,
    config: SolverConfig,
    hint_solution: MasterSolution | None = None,
) -> _BuiltModel:
    model = cp_model.CpModel()
    timezone = master.planning_at.tzinfo
    if timezone is None:
        raise ValueError('planning_at must have a timezone')
    day_start = master.planning_at.replace(hour=0, minute=0, second=0, microsecond=0)
    horizon = 24 * 60
    active_jobs = {
        job_id: dataset.jobs[job_id]
        for job_id in master.candidate_index.active_job_ids
    }
    candidate_pairs = [
        (engineer_id, job_id)
        for job_id, engineer_ids in master.candidate_index.eligible_engineers_by_job.items()
        for engineer_id in engineer_ids
    ]
    assignment = {
        pair: model.new_bool_var(f'x[{pair[0]},{pair[1]}]') for pair in candidate_pairs
    }
    unserved = {
        job_id: model.new_bool_var(f'u[{job_id}]') for job_id in sorted(active_jobs)
    }
    used = {
        engineer_id: model.new_bool_var(f'y[{engineer_id}]')
        for engineer_id in sorted(dataset.engineers)
    }
    service_start = {
        job_id: model.new_int_var(
            _minute(day_start, job.window_start),
            _minute(day_start, job.window_end),
            f's[{job_id}]',
        )
        for job_id, job in active_jobs.items()
    }
    departure = {
        pair: model.new_int_var(0, horizon, f'd[{pair[0]},{pair[1]}]')
        for pair in candidate_pairs
    }
    waiting = {
        pair: model.new_int_var(0, horizon, f'w[{pair[0]},{pair[1]}]')
        for pair in candidate_pairs
    }
    hint_arcs = frozenset(
        (
            route.engineer_id,
            visit.origin_node_id,
            visit.job_id,
        )
        for route in hint_solution.routes
        for visit in route.visits
    ) if hint_solution is not None else frozenset()
    search_arcs, search_graph_complete = _select_search_arcs(
        master.arcs,
        config.max_predecessors_per_destination,
        config.excluded_arcs,
        hint_arcs,
    )
    arcs_by_key = {
        (item.engineer_id, item.origin_node_id, item.destination_job_id): item
        for item in search_arcs
    }
    arc = {
        key: model.new_bool_var(f'a[{key[0]},{key[1]},{key[2]}]')
        for key in arcs_by_key
    }
    finish = {
        pair: model.new_bool_var(f'f[{pair[0]},{pair[1]}]') for pair in candidate_pairs
    }
    route_start = {
        engineer_id: model.new_int_var(0, horizon, f'route_start[{engineer_id}]')
        for engineer_id in sorted(dataset.engineers)
    }
    route_end = {
        engineer_id: model.new_int_var(0, horizon, f'route_end[{engineer_id}]')
        for engineer_id in sorted(dataset.engineers)
    }
    route_load = {
        engineer_id: model.new_int_var(
            0,
            dataset.engineers[engineer_id].max_route_minutes,
            f'route_load[{engineer_id}]',
        )
        for engineer_id in sorted(dataset.engineers)
    }
    variables = _Variables(
        assignment=assignment,
        unserved=unserved,
        used=used,
        arc=arc,
        finish=finish,
        service_start=service_start,
        departure=departure,
        waiting=waiting,
        route_start=route_start,
        route_end=route_end,
        route_load=route_load,
    )

    incoming: dict[tuple[str, str], list[cp_model.IntVar]] = {
        pair: [] for pair in candidate_pairs
    }
    outgoing: dict[tuple[str, str], list[cp_model.IntVar]] = {
        pair: [] for pair in candidate_pairs
    }
    start_arcs: dict[str, list[cp_model.IntVar]] = {
        engineer_id: [] for engineer_id in dataset.engineers
    }
    for key, arc_var in arc.items():
        engineer_id, origin_node_id, destination_job_id = key
        incoming[(engineer_id, destination_job_id)].append(arc_var)
        if origin_node_id.startswith('START:'):
            start_arcs[engineer_id].append(arc_var)
        else:
            outgoing[(engineer_id, origin_node_id)].append(arc_var)

    for job_id in sorted(active_jobs):
        choices = [
            assignment[(engineer_id, job_id)]
            for engineer_id in master.candidate_index.eligible_engineers_by_job[job_id]
        ]
        model.add(_sum(choices) + unserved[job_id] == 1)

    for engineer_id in sorted(dataset.engineers):
        engineer_pairs = [pair for pair in candidate_pairs if pair[0] == engineer_id]
        model.add(_sum(start_arcs[engineer_id]) == used[engineer_id])
        model.add(_sum(finish[pair] for pair in engineer_pairs) == used[engineer_id])
        model.add(_sum(assignment[pair] for pair in engineer_pairs) <= dataset.engineers[engineer_id].max_jobs)
        for pair in engineer_pairs:
            model.add(_sum(incoming[pair]) == assignment[pair])
            model.add(_sum(outgoing[pair]) + finish[pair] == assignment[pair])
            model.add(assignment[pair] <= used[engineer_id])

    if config.max_used_engineers is not None:
        model.add(_sum(used.values()) <= config.max_used_engineers)

    for engineer_id, job_id in master.hard_assignments:
        model.add(assignment[(engineer_id, job_id)] == 1)

    inventory_available = {
        (item.zone_id, item.equipment_id): item.quantity_available
        for item in dataset.shared_inventory
    }
    for inventory_key, available in sorted(inventory_available.items()):
        terms: list[cp_model.LinearExpr] = []
        zone_id, equipment_id = inventory_key
        for job_id, job in active_jobs.items():
            if job.zone_id != zone_id:
                continue
            quantity = next(
                (
                    need.quantity
                    for need in job.required_equipment
                    if need.equipment_id == equipment_id
                ),
                0,
            )
            if quantity:
                terms.append(quantity * (1 - unserved[job_id]))
        model.add(_sum(terms) <= available)

    incoming_costs: dict[tuple[str, str], list[tuple[MasterArc, cp_model.IntVar]]] = {
        pair: [] for pair in candidate_pairs
    }
    for key, arc_var in arc.items():
        arc_data = arcs_by_key[key]
        pair = (arc_data.engineer_id, arc_data.destination_job_id)
        incoming_costs[pair].append((arc_data, arc_var))
        engineer_id, origin_node_id, destination_job_id = key
        destination_departure = departure[(engineer_id, destination_job_id)]
        if not origin_node_id.startswith('START:'):
            origin = active_jobs[origin_node_id]
            # With time-independent screening costs, delaying departure after a
            # completed job is equivalent to departing immediately and waiting at
            # the destination. Equality removes a large symmetry and makes every
            # minute of in-route idle time explicit in `waiting`.
            model.add(
                destination_departure
                == service_start[origin_node_id] + origin.service_duration_min
            ).only_enforce_if(arc_var)

    planning_minute = _minute(day_start, master.planning_at)
    for pair in candidate_pairs:
        engineer_id, job_id = pair
        engineer = dataset.engineers[engineer_id]
        job = active_jobs[job_id]
        x = assignment[pair]
        travel_expression = _sum(
            data.screening_duration_minutes * arc_var
            for data, arc_var in incoming_costs[pair]
        )
        model.add(
            service_start[job_id] == departure[pair] + travel_expression + waiting[pair]
        ).only_enforce_if(x)
        model.add(departure[pair] == 0).only_enforce_if(x.negated())
        model.add(waiting[pair] == 0).only_enforce_if(x.negated())
        earliest_departure = max(
            planning_minute,
            _minute(day_start, engineer.shift_start),
            _minute(day_start, job.created_at),
        )
        model.add(departure[pair] >= earliest_departure).only_enforce_if(x)
        model.add(
            service_start[job_id] + job.service_duration_min
            <= _minute(day_start, engineer.shift_end)
        ).only_enforce_if(x)

    for engineer_id in sorted(dataset.engineers):
        engineer_pairs = [pair for pair in candidate_pairs if pair[0] == engineer_id]
        y = used[engineer_id]
        model.add(route_start[engineer_id] == 0).only_enforce_if(y.negated())
        model.add(route_end[engineer_id] == 0).only_enforce_if(y.negated())
        model.add(route_load[engineer_id] == 0).only_enforce_if(y.negated())
        model.add(
            route_load[engineer_id] == route_end[engineer_id] - route_start[engineer_id]
        ).only_enforce_if(y)
        for pair in engineer_pairs:
            _, job_id = pair
            start_key = (engineer_id, f'START:{engineer_id}', job_id)
            start_var = arc.get(start_key)
            if start_var is not None:
                model.add(route_start[engineer_id] == departure[pair]).only_enforce_if(start_var)
            model.add(
                route_end[engineer_id]
                == service_start[job_id] + active_jobs[job_id].service_duration_min
            ).only_enforce_if(finish[pair])

    total_screening_distance = _sum(
        arcs_by_key[key].screening_distance_m * arc_var for key, arc_var in arc.items()
    )
    total_screening_travel = _sum(
        arcs_by_key[key].screening_duration_minutes * arc_var
        for key, arc_var in arc.items()
    )
    total_waiting = _sum(waiting.values())

    urgent_response_terms: list[cp_model.IntVar] = []
    for job_id, job in active_jobs.items():
        if job.priority != Priority.URGENT:
            continue
        response_origin = _minute(day_start, max(master.planning_at, job.created_at))
        response = model.new_int_var(0, horizon, f'urgent_response[{job_id}]')
        model.add(
            response == service_start[job_id] - response_origin
        ).only_enforce_if(unserved[job_id].negated())
        model.add(response == 0).only_enforce_if(unserved[job_id])
        urgent_response_terms.append(response)

    pairwise_load_differences: list[cp_model.IntVar] = []
    engineer_ids = sorted(dataset.engineers)
    max_route = max(engineer.max_route_minutes for engineer in dataset.engineers.values())
    for left_index, left in enumerate(engineer_ids):
        for right in engineer_ids[left_index + 1:]:
            both = model.new_bool_var(f'both_used[{left},{right}]')
            model.add(both <= used[left])
            model.add(both <= used[right])
            model.add(both >= used[left] + used[right] - 1)
            difference = model.new_int_var(0, max_route, f'load_diff[{left},{right}]')
            model.add(difference >= route_load[left] - route_load[right]).only_enforce_if(both)
            model.add(difference >= route_load[right] - route_load[left]).only_enforce_if(both)
            model.add(difference == 0).only_enforce_if(both.negated())
            pairwise_load_differences.append(difference)

    stable_assignment_rank = {
        pair: index + 1 for index, pair in enumerate(sorted(candidate_pairs))
    }
    stable_arc_rank = {key: index + 1 for index, key in enumerate(sorted(arc))}
    deterministic_tie_break = (
        _sum(stable_assignment_rank[pair] * variable for pair, variable in assignment.items())
        + _sum(stable_arc_rank[key] * variable for key, variable in arc.items())
    )
    coverage_tiers: tuple[tuple[str, cp_model.LinearExpr], ...] = (
        (
            'unserved_urgent_jobs',
            _sum(
                unserved[job_id]
                for job_id, job in active_jobs.items()
                if job.priority == Priority.URGENT
            ),
        ),
        (
            'unserved_normal_jobs',
            _sum(
                unserved[job_id]
                for job_id, job in active_jobs.items()
                if job.priority == Priority.NORMAL
            ),
        ),
    )
    service_quality_tiers: tuple[tuple[str, cp_model.LinearExpr], ...] = (
        ('urgent_response_minutes', _sum(urgent_response_terms)),
        ('screening_total_distance_m', total_screening_distance),
        ('screening_total_travel_minutes', total_screening_travel),
        ('screening_total_waiting_minutes', total_waiting),
        ('screening_workload_imbalance_minutes', _sum(pairwise_load_differences)),
        ('used_engineers', _sum(used.values())),
        ('deterministic_tie_break', deterministic_tie_break),
    )
    compact_team_tiers: tuple[tuple[str, cp_model.LinearExpr], ...] = (
        ('used_engineers', _sum(used.values())),
        ('urgent_response_minutes', _sum(urgent_response_terms)),
        ('screening_total_distance_m', total_screening_distance),
        ('screening_total_travel_minutes', total_screening_travel),
        ('screening_total_waiting_minutes', total_waiting),
        ('screening_workload_imbalance_minutes', _sum(pairwise_load_differences)),
        ('deterministic_tie_break', deterministic_tie_break),
    )
    objective_tiers = coverage_tiers + (
        service_quality_tiers
        if config.objective_policy == ObjectivePolicy.SERVICE_QUALITY
        else compact_team_tiers
    )

    if hint_solution is None:
        _add_greedy_hint(
            model=model,
            variables=variables,
            dataset=dataset,
            master=master,
            active_jobs=active_jobs,
            arcs_by_key=arcs_by_key,
            day_start=day_start,
        )
    else:
        _add_solution_structure_hint(
            model=model,
            variables=variables,
            dataset=dataset,
            active_jobs=active_jobs,
            arcs_by_key=arcs_by_key,
            solution=hint_solution,
        )

    return _BuiltModel(
        model=model,
        variables=variables,
        arcs_by_key=arcs_by_key,
        objective_tiers=objective_tiers,
        search_graph_complete=search_graph_complete,
        operationally_excluded_arcs=config.excluded_arcs,
    )


def _add_solution_structure_hint(
    *,
    model: cp_model.CpModel,
    variables: _Variables,
    dataset: PlanningDataset,
    active_jobs: dict[str, Job],
    arcs_by_key: dict[tuple[str, str, str], MasterArc],
    solution: MasterSolution,
) -> None:
    """Warm-start assignments and route order from another audited search."""
    if solution.dataset_sha256 != dataset.dataset_sha256:
        raise ValueError('Hint solution belongs to another dataset checksum')
    assigned_engineer: dict[str, str] = {}
    selected_arcs: set[tuple[str, str, str]] = set()
    used_engineers: set[str] = set()
    hinted_times: dict[tuple[str, str], tuple[int, int]] = {}
    day_start = solution.planning_at.replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    for route in solution.routes:
        if route.engineer_id not in dataset.engineers:
            raise ValueError(f'Hint contains unknown engineer {route.engineer_id}')
        used_engineers.add(route.engineer_id)
        origin = f'START:{route.engineer_id}'
        for visit in route.visits:
            if visit.job_id not in active_jobs:
                raise ValueError(f'Hint contains inactive job {visit.job_id}')
            if visit.job_id in assigned_engineer:
                raise ValueError(f'Hint assigns job twice: {visit.job_id}')
            assigned_engineer[visit.job_id] = route.engineer_id
            hinted_times[(route.engineer_id, visit.job_id)] = (
                _minute(day_start, visit.departure_at),
                _minute(day_start, visit.service_start_at),
            )
            key = (route.engineer_id, origin, visit.job_id)
            if key in arcs_by_key:
                selected_arcs.add(key)
            origin = visit.job_id
    unserved = set(solution.unserved_job_ids)
    if set(active_jobs) != set(assigned_engineer) | unserved:
        raise ValueError('Hint must cover every active job exactly once')
    if set(assigned_engineer) & unserved:
        raise ValueError('Hint assigns a job also marked unserved')

    model.clear_hints()
    for pair, variable in variables.assignment.items():
        model.add_hint(variable, int(assigned_engineer.get(pair[1]) == pair[0]))
    for job_id, variable in variables.unserved.items():
        model.add_hint(variable, int(job_id in unserved))
    for engineer_id, variable in variables.used.items():
        model.add_hint(variable, int(engineer_id in used_engineers))
    for key, variable in variables.arc.items():
        model.add_hint(variable, int(key in selected_arcs))
    for key, (departure_minute, service_minute) in hinted_times.items():
        departure = variables.departure.get(key)
        service_start = variables.service_start.get(key[1])
        if departure is not None:
            model.add_hint(departure, departure_minute)
        if service_start is not None:
            model.add_hint(service_start, service_minute)


def _add_greedy_hint(
    *,
    model: cp_model.CpModel,
    variables: _Variables,
    dataset: PlanningDataset,
    master: MasterModelInput,
    active_jobs: dict[str, Job],
    arcs_by_key: dict[tuple[str, str, str], MasterArc],
    day_start: datetime,
) -> None:
    """Construct a deterministic feasible incumbent for the screening model."""
    # Importing the concrete type only for the checker would make the signature
    # noisy; values originate directly from dataset.jobs and are validated there.
    jobs = {job_id: dataset.jobs[job_id] for job_id in active_jobs}
    planning_minute = _minute(day_start, master.planning_at)
    inventory_remaining = {
        (item.zone_id, item.equipment_id): item.quantity_available
        for item in dataset.shared_inventory
    }
    committed = {job_id: engineer_id for engineer_id, job_id in master.hard_assignments}
    routes: dict[str, list[tuple[str, tuple[str, str, str], int, int]]] = {
        engineer_id: [] for engineer_id in dataset.engineers
    }
    assigned: dict[str, str] = {}

    def order_key(job_id: str) -> tuple[int, int, int, str]:
        job = jobs[job_id]
        return (
            0 if job_id in committed else 1 if job.priority == Priority.URGENT else 2,
            _minute(day_start, job.window_end),
            _minute(day_start, job.window_start),
            job_id,
        )

    for job_id in sorted(jobs, key=order_key):
        job = jobs[job_id]
        candidates = master.candidate_index.eligible_engineers_by_job[job_id]
        if job_id in committed:
            candidates = (committed[job_id],)
        demands = {
            (job.zone_id, need.equipment_id): need.quantity
            for need in job.required_equipment
            if dataset.equipment_catalog[need.equipment_id].shared_stock
        }
        if any(
            inventory_remaining[demand_key] < quantity
            for demand_key, quantity in demands.items()
        ):
            continue
        options: list[tuple[tuple[int, int, int, int, str], str, tuple[str, str, str], int, int]] = []
        for engineer_id in candidates:
            engineer = dataset.engineers[engineer_id]
            current = routes[engineer_id]
            if len(current) >= engineer.max_jobs:
                continue
            if current:
                origin_node_id = current[-1][0]
                previous_job = jobs[origin_node_id]
                depart = current[-1][3] + previous_job.service_duration_min
            else:
                origin_node_id = f'START:{engineer_id}'
                depart = max(
                    planning_minute,
                    _minute(day_start, engineer.shift_start),
                    _minute(day_start, job.created_at),
                )
            arc_key = (engineer_id, origin_node_id, job_id)
            arc_data = arcs_by_key.get(arc_key)
            if arc_data is None:
                continue
            if not current:
                depart = max(
                    depart,
                    _minute(day_start, job.window_start) - arc_data.screening_duration_minutes,
                )
            service_start = max(
                _minute(day_start, job.window_start),
                depart + arc_data.screening_duration_minutes,
            )
            service_end = service_start + job.service_duration_min
            if service_start > _minute(day_start, job.window_end):
                continue
            if service_end > _minute(day_start, engineer.shift_end):
                continue
            first_departure = current[0][2] if current else depart
            if service_end - first_departure > engineer.max_route_minutes:
                continue
            score = (
                0 if current else 1,
                service_end,
                arc_data.screening_duration_minutes,
                arc_data.screening_distance_m,
                engineer_id,
            )
            options.append((score, engineer_id, arc_key, depart, service_start))
        if not options:
            continue
        _, engineer_id, arc_key, depart, service_start = min(options)
        routes[engineer_id].append((job_id, arc_key, depart, service_start))
        assigned[job_id] = engineer_id
        for demand_key, quantity in demands.items():
            inventory_remaining[demand_key] -= quantity

    selected_arcs = {
        arc_key for route in routes.values() for _, arc_key, _, _ in route
    }
    for pair, variable in variables.assignment.items():
        model.add_hint(variable, int(assigned.get(pair[1]) == pair[0]))
    for job_id, variable in variables.unserved.items():
        model.add_hint(variable, int(job_id not in assigned))
    for engineer_id, variable in variables.used.items():
        model.add_hint(variable, int(bool(routes[engineer_id])))
    for arc_variable_key, variable in variables.arc.items():
        model.add_hint(variable, int(arc_variable_key in selected_arcs))
    for pair, variable in variables.finish.items():
        route = routes[pair[0]]
        final_job_id = route[-1][0] if route else None
        model.add_hint(variable, int(pair[1] == final_job_id))
    schedule = {
        (engineer_id, job_id): (depart, service_start, arc_key)
        for engineer_id, route in routes.items()
        for job_id, arc_key, depart, service_start in route
    }
    for pair, variable in variables.departure.items():
        model.add_hint(variable, schedule.get(pair, (0, 0, ()))[0])
    for pair, variable in variables.waiting.items():
        entry = schedule.get(pair)
        if entry is None:
            model.add_hint(variable, 0)
        else:
            depart, service_start, arc_key = entry
            travel = arcs_by_key[arc_key].screening_duration_minutes
            model.add_hint(variable, service_start - depart - travel)
    for job_id, variable in variables.service_start.items():
        assigned_engineer = assigned.get(job_id)
        value = (
            schedule[(assigned_engineer, job_id)][1]
            if assigned_engineer is not None
            else _minute(day_start, jobs[job_id].window_start)
        )
        model.add_hint(variable, value)
    for engineer_id in variables.used:
        route = routes[engineer_id]
        if not route:
            start = end = load = 0
        else:
            start = route[0][2]
            last_job_id = route[-1][0]
            end = route[-1][3] + jobs[last_job_id].service_duration_min
            load = end - start
        model.add_hint(variables.route_start[engineer_id], start)
        model.add_hint(variables.route_end[engineer_id], end)
        model.add_hint(variables.route_load[engineer_id], load)


def _configure_solver(
    config: SolverConfig,
    *,
    max_seconds: float | None = None,
) -> cp_model.CpSolver:
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = (
        config.max_seconds_per_tier if max_seconds is None else max_seconds
    )
    solver.parameters.random_seed = config.random_seed
    solver.parameters.num_search_workers = config.num_search_workers
    solver.parameters.log_search_progress = config.log_search_progress
    solver.parameters.cp_model_presolve = config.cp_model_presolve
    solver.parameters.max_presolve_iterations = config.max_presolve_iterations
    solver.parameters.presolve_probing_deterministic_time_limit = (
        config.presolve_probing_deterministic_time_limit
    )
    return solver


def _replace_hint_with_solution(model: cp_model.CpModel, solver: cp_model.CpSolver) -> None:
    """Warm-start the next lexicographic tier with the complete prior solution."""
    model.clear_hints()
    for index in range(len(model.proto.variables)):
        variable = model.get_int_var_from_proto_index(index)
        model.add_hint(variable, solver.value(variable))


def _extract_solution(
    dataset: PlanningDataset,
    master: MasterModelInput,
    built: _BuiltModel,
    solver: cp_model.CpSolver,
    status: MasterSolveStatus,
    proofs: list[ObjectiveProof],
) -> MasterSolution:
    variables = built.variables
    routes: list[MasterEngineerRoute] = []
    for engineer_id in sorted(dataset.engineers):
        if solver.value(variables.used[engineer_id]) == 0:
            continue
        current = f'START:{engineer_id}'
        visits: list[MasterVisit] = []
        seen: set[str] = set()
        while True:
            selected = [
                (key, arc_data)
                for key, arc_data in built.arcs_by_key.items()
                if key[0] == engineer_id
                and key[1] == current
                and solver.value(variables.arc[key]) == 1
            ]
            if not selected:
                break
            if len(selected) != 1:
                raise RuntimeError(f'Invalid solver flow at {engineer_id}/{current}')
            key, arc_data = selected[0]
            job_id = key[2]
            if job_id in seen:
                raise RuntimeError(f'Solver returned a route cycle for {engineer_id}')
            seen.add(job_id)
            departure_minute = solver.value(variables.departure[(engineer_id, job_id)])
            service_minute = solver.value(variables.service_start[job_id])
            day_start = master.planning_at.replace(hour=0, minute=0, second=0, microsecond=0)
            visits.append(
                MasterVisit(
                    sequence=len(visits) + 1,
                    job_id=job_id,
                    origin_node_id=current,
                    departure_at=day_start + timedelta(minutes=departure_minute),
                    service_start_at=day_start + timedelta(minutes=service_minute),
                    screening_duration_minutes=arc_data.screening_duration_minutes,
                    screening_distance_m=arc_data.screening_distance_m,
                    screening_source_mode=arc_data.screening_source_mode.value,
                    screening_is_surrogate=arc_data.screening_is_surrogate,
                )
            )
            current = job_id
        routes.append(MasterEngineerRoute(engineer_id=engineer_id, visits=tuple(visits)))
    unserved_job_ids = tuple(
        job_id
        for job_id in sorted(variables.unserved)
        if solver.value(variables.unserved[job_id]) == 1
    )
    return MasterSolution(
        status=status,
        planning_at=master.planning_at,
        routes=tuple(routes),
        unserved_job_ids=unserved_job_ids,
        objective_proofs=tuple(proofs),
        dataset_sha256=dataset.dataset_sha256,
        screening_snapshot_sha256=master.screening_snapshot_sha256,
        solver_version=version('ortools'),
        search_graph_complete=built.search_graph_complete,
        searched_arc_count=len(built.arcs_by_key),
        operationally_excluded_arcs=built.operationally_excluded_arcs,
    )


def solve_screening_master(
    dataset: PlanningDataset,
    master: MasterModelInput,
    config: SolverConfig = SolverConfig(),
    *,
    hint_solution: MasterSolution | None = None,
) -> MasterSolution:
    """Find complete coverage first, then solve proven lexicographic tiers.

    With the default strict policy an unfinished search is never converted into
    a publishable partial plan. Partial coverage is considered only after the
    complete search graph has proven that zero unserved jobs is infeasible and
    the caller has explicitly enabled that fallback.
    """
    built = _build_cp_model(dataset, master, config, hint_solution)
    proofs: list[ObjectiveProof] = []
    last_solver: cp_model.CpSolver | None = None
    objective_tiers = built.objective_tiers
    starting_tier = 1

    if config.fixed_unserved_by_priority is not None:
        urgent, normal = config.fixed_unserved_by_priority
        urgent_metric, urgent_expression = built.objective_tiers[0]
        normal_metric, normal_expression = built.objective_tiers[1]
        built.model.add(urgent_expression == urgent)
        built.model.add(normal_expression == normal)
        proofs.extend((
            ObjectiveProof(1, urgent_metric, urgent, urgent, False, 0.0),
            ObjectiveProof(2, normal_metric, normal, normal, False, 0.0),
        ))
        objective_tiers = built.objective_tiers[2:]
        starting_tier = 3

    if config.require_full_coverage:
        for variable in built.variables.unserved.values():
            built.model.add(variable == 0)
        coverage_solver = _configure_solver(
            config,
            max_seconds=config.full_coverage_seconds,
        )
        coverage_status = coverage_solver.solve(built.model)
        if coverage_status in {cp_model.OPTIMAL, cp_model.FEASIBLE}:
            proofs.extend((
                ObjectiveProof(
                    tier=1,
                    metric='unserved_urgent_jobs',
                    value=0,
                    best_bound=0,
                    proven_optimal=True,
                    wall_time_seconds=coverage_solver.wall_time,
                ),
                ObjectiveProof(
                    tier=2,
                    metric='unserved_normal_jobs',
                    value=0,
                    best_bound=0,
                    proven_optimal=True,
                    wall_time_seconds=coverage_solver.wall_time,
                ),
            ))
            last_solver = coverage_solver
            objective_tiers = built.objective_tiers[2:]
            starting_tier = 3
            _replace_hint_with_solution(built.model, coverage_solver)
        elif coverage_status == cp_model.INFEASIBLE:
            if (
                not built.search_graph_complete
                or not config.allow_partial_after_proven_infeasible
            ):
                return MasterSolution(
                    status=MasterSolveStatus.SCREENING_INFEASIBLE,
                    planning_at=master.planning_at,
                    routes=(),
                    unserved_job_ids=(),
                    objective_proofs=(),
                    dataset_sha256=dataset.dataset_sha256,
                    screening_snapshot_sha256=master.screening_snapshot_sha256,
                    solver_version=version('ortools'),
                    search_graph_complete=built.search_graph_complete,
                    searched_arc_count=len(built.arcs_by_key),
                    operationally_excluded_arcs=config.excluded_arcs,
                )
            built = _build_cp_model(dataset, master, config, hint_solution)
            objective_tiers = built.objective_tiers
        else:
            return MasterSolution(
                status=MasterSolveStatus.NO_SOLUTION_WITHIN_LIMIT,
                planning_at=master.planning_at,
                routes=(),
                unserved_job_ids=(),
                objective_proofs=(),
                dataset_sha256=dataset.dataset_sha256,
                screening_snapshot_sha256=master.screening_snapshot_sha256,
                solver_version=version('ortools'),
                search_graph_complete=built.search_graph_complete,
                searched_arc_count=len(built.arcs_by_key),
                operationally_excluded_arcs=config.excluded_arcs,
            )

    for tier, (metric, expression) in enumerate(
        objective_tiers,
        start=starting_tier,
    ):
        built.model.minimize(expression)
        solver = _configure_solver(config)
        raw_status = solver.solve(built.model)
        if raw_status == cp_model.INFEASIBLE:
            return MasterSolution(
                status=MasterSolveStatus.SCREENING_INFEASIBLE,
                planning_at=master.planning_at,
                routes=(),
                unserved_job_ids=(),
                objective_proofs=tuple(proofs),
                dataset_sha256=dataset.dataset_sha256,
                screening_snapshot_sha256=master.screening_snapshot_sha256,
                solver_version=version('ortools'),
                search_graph_complete=built.search_graph_complete,
                searched_arc_count=len(built.arcs_by_key),
                operationally_excluded_arcs=config.excluded_arcs,
            )
        if raw_status not in {cp_model.OPTIMAL, cp_model.FEASIBLE}:
            if last_solver is None:
                return MasterSolution(
                    status=MasterSolveStatus.NO_SOLUTION_WITHIN_LIMIT,
                    planning_at=master.planning_at,
                    routes=(),
                    unserved_job_ids=(),
                    objective_proofs=tuple(proofs),
                    dataset_sha256=dataset.dataset_sha256,
                    screening_snapshot_sha256=master.screening_snapshot_sha256,
                    solver_version=version('ortools'),
                    search_graph_complete=built.search_graph_complete,
                    searched_arc_count=len(built.arcs_by_key),
                    operationally_excluded_arcs=config.excluded_arcs,
                )
            return _extract_solution(
                dataset,
                master,
                built,
                last_solver,
                MasterSolveStatus.SCREENING_FEASIBLE,
                proofs,
            )
        value = int(round(solver.objective_value))
        # Every objective tier is a sum of non-negative integer quantities.
        # Therefore value 0 is independently proven optimal even when CP-SAT
        # reaches the wall-time limit before reporting its own OPTIMAL status.
        bound = max(0, int(round(solver.best_objective_bound)))
        optimal = raw_status == cp_model.OPTIMAL or value == 0
        proofs.append(
            ObjectiveProof(
                tier=tier,
                metric=metric,
                value=value,
                best_bound=bound,
                proven_optimal=optimal,
                wall_time_seconds=solver.wall_time,
            )
        )
        last_solver = solver
        if not optimal:
            return _extract_solution(
                dataset,
                master,
                built,
                solver,
                MasterSolveStatus.SCREENING_FEASIBLE,
                proofs,
            )
        built.model.add(expression == value)
        _replace_hint_with_solution(built.model, solver)

    if last_solver is None:
        raise RuntimeError('Model has no objective tiers')
    if config.fixed_unserved_by_priority is not None:
        # The polishing run proves nothing about better coverage because its
        # incumbent coverage is deliberately fixed by the caller.
        final_status = MasterSolveStatus.SCREENING_FEASIBLE
    elif built.search_graph_complete:
        final_status = MasterSolveStatus.SCREENING_OPTIMAL
    else:
        final_status = MasterSolveStatus.SCREENING_RESTRICTED_OPTIMAL
    return _extract_solution(
        dataset,
        master,
        built,
        last_solver,
        final_status,
        proofs,
    )
