"""Exact-aware large-neighbourhood search for coverage repair."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta
from time import monotonic
from typing import Callable, Mapping

from .domain import PlanningDataset, Priority
from .eligibility import CandidateIndex
from .exact_repair import zero_travel_order_feasible


RouteCheck = Callable[[str, tuple[str, ...]], bool]


class _RouteBudgetReached(Exception):
    pass


@dataclass(frozen=True, slots=True)
class ExactLnsMove:
    """One coverage-increasing rebuild of several complete engineer routes."""

    inserted_job_id: str
    routes: Mapping[str, tuple[str, ...]]
    destroyed_job_ids: tuple[str, ...]
    neighbourhood_engineer_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ExactLnsSearchReport:
    """Bounded exact LNS result; absence of a move is not an infeasibility proof."""

    move: ExactLnsMove | None
    route_checks: int
    expanded_states: int
    zero_travel_rejections: int
    neighbourhoods_tried: int
    complete_states_checked: int
    budget_exhausted: bool


def _window_gap_minutes(left_start: datetime, left_end: datetime,
                        right_start: datetime, right_end: datetime) -> int:
    if left_end < right_start:
        return int((right_start - left_end).total_seconds() // 60)
    if right_end < left_start:
        return int((left_start - right_end).total_seconds() // 60)
    return 0


def _route_window_gap(dataset: PlanningDataset, order: tuple[str, ...],
                      target_job_id: str) -> int:
    if not order:
        return 24 * 60
    target = dataset.jobs[target_job_id]
    return min(
        _window_gap_minutes(
            dataset.jobs[job_id].window_start,
            dataset.jobs[job_id].window_end,
            target.window_start,
            target.window_end,
        )
        for job_id in order
    )


def _neighbourhood_engineers(
    dataset: PlanningDataset,
    routes: Mapping[str, tuple[str, ...]],
    candidates: CandidateIndex,
    target_job_id: str,
    anchor_engineer_id: str,
    max_engineers: int,
) -> tuple[str, ...]:
    target = dataset.jobs[target_job_id]
    zone_engineers = tuple(
        engineer_id
        for engineer_id, engineer in dataset.engineers.items()
        if engineer.zone_id == target.zone_id
    )
    relevant_jobs = tuple(sorted(
        (
            job_id
            for engineer_id in zone_engineers
            for job_id in routes.get(engineer_id, ())
        ),
        key=lambda job_id: (
            _window_gap_minutes(
                dataset.jobs[job_id].window_start,
                dataset.jobs[job_id].window_end,
                target.window_start,
                target.window_end,
            ),
            dataset.jobs[job_id].window_end,
            job_id,
        ),
    )[: max(8, max_engineers * 4)])

    def rank(engineer_id: str) -> tuple[object, ...]:
        relief_options = sum(
            engineer_id in candidates.eligible_engineers_by_job[job_id]
            for job_id in relevant_jobs
        )
        return (
            engineer_id != anchor_engineer_id,
            engineer_id not in candidates.eligible_engineers_by_job[target_job_id],
            -relief_options,
            bool(routes.get(engineer_id, ())),
            _route_window_gap(
                dataset, tuple(routes.get(engineer_id, ())), target_job_id
            ),
            engineer_id,
        )

    return tuple(sorted(zone_engineers, key=rank)[:max_engineers])


def _destroyed_jobs(
    dataset: PlanningDataset,
    routes: Mapping[str, tuple[str, ...]],
    engineer_ids: tuple[str, ...],
    target_job_id: str,
    max_destroyed_jobs: int,
    window_padding_minutes: int,
    neighbour_radius: int,
) -> tuple[str, ...]:
    target = dataset.jobs[target_job_id]
    selected: set[str] = set()
    for engineer_id in engineer_ids:
        order = tuple(routes.get(engineer_id, ()))
        positions = sorted(
            range(len(order)),
            key=lambda index: (
                _window_gap_minutes(
                    dataset.jobs[order[index]].window_start,
                    dataset.jobs[order[index]].window_end,
                    target.window_start,
                    target.window_end,
                ),
                index,
            ),
        )
        anchor_positions = positions[:2]
        for position in anchor_positions:
            for neighbour in range(
                max(0, position - neighbour_radius),
                min(len(order), position + neighbour_radius + 1),
            ):
                selected.add(order[neighbour])
        for job_id in order:
            job = dataset.jobs[job_id]
            gap = _window_gap_minutes(
                job.window_start,
                job.window_end,
                target.window_start,
                target.window_end,
            )
            if gap <= window_padding_minutes:
                selected.add(job_id)
    ordered = sorted(
        selected,
        key=lambda job_id: (
            _window_gap_minutes(
                dataset.jobs[job_id].window_start,
                dataset.jobs[job_id].window_end,
                target.window_start,
                target.window_end,
            ),
            dataset.jobs[job_id].priority != Priority.URGENT,
            dataset.jobs[job_id].window_end,
            job_id,
        ),
    )
    return tuple(ordered[:max_destroyed_jobs])


def _zero_travel_span(
    dataset: PlanningDataset,
    engineer_id: str,
    order: tuple[str, ...],
) -> int:
    if not order:
        return 0
    engineer = dataset.engineers[engineer_id]
    moment = max(
        dataset.initial_planning_at,
        engineer.shift_start,
        dataset.jobs[order[0]].created_at,
    )
    start = moment
    for job_id in order:
        job = dataset.jobs[job_id]
        moment = max(moment, job.created_at, job.window_start)
        moment = moment.replace(second=0, microsecond=0)
        moment += timedelta(minutes=job.service_duration_min)
    return int((moment - start).total_seconds() // 60)


def find_exact_lns_coverage_move(
    dataset: PlanningDataset,
    routes: Mapping[str, tuple[str, ...]],
    unserved_job_ids: set[str],
    candidates: CandidateIndex,
    route_check: RouteCheck,
    *,
    max_route_checks: int = 2500,
    beam_width: int = 48,
    max_destroyed_jobs: int = 12,
    max_engineers: int = 4,
    window_padding_minutes: int = 120,
    neighbour_radius: int = 1,
    max_seconds: float | None = None,
) -> ExactLnsSearchReport:
    """Rebuild a time-window cluster and verify every changed route exactly.

    The search removes several neighbouring visits at once, keeps the rest of
    each route fixed, and reinserts the removed visits together with one
    unserved job.  Every generated route order is accepted only through
    ``route_check``; callers must still validate the complete plan.
    """
    if min(
        max_route_checks,
        beam_width,
        max_destroyed_jobs,
        max_engineers,
    ) < 1:
        raise ValueError('Exact LNS budgets must be positive')
    if window_padding_minutes < 0 or neighbour_radius < 0:
        raise ValueError('Exact LNS neighbourhood limits must be non-negative')
    if max_seconds is not None and max_seconds <= 0:
        raise ValueError('Exact LNS time budget must be positive')
    if not unserved_job_ids:
        return ExactLnsSearchReport(None, 0, 0, 0, 0, 0, False)

    stock_available = {
        (item.zone_id, item.equipment_id): item.quantity_available
        for item in dataset.shared_inventory
    }
    stock_used: Counter[tuple[str, str]] = Counter()
    for order in routes.values():
        for job_id in order:
            job = dataset.jobs[job_id]
            for need in job.required_equipment:
                if dataset.equipment_catalog[need.equipment_id].shared_stock:
                    stock_used[job.zone_id, need.equipment_id] += need.quantity

    def stock_allows(job_id: str) -> bool:
        job = dataset.jobs[job_id]
        return all(
            not dataset.equipment_catalog[need.equipment_id].shared_stock
            or stock_used[job.zone_id, need.equipment_id] + need.quantity
            <= stock_available.get((job.zone_id, need.equipment_id), 0)
            for need in job.required_equipment
        )

    checked: dict[tuple[str, tuple[str, ...]], bool] = {
        (engineer_id, tuple(order)): True
        for engineer_id, order in routes.items()
    }
    route_checks = 0
    expanded_states = 0
    zero_rejections = 0
    neighbourhoods_tried = 0
    complete_states_checked = 0
    budget_exhausted = False
    deadline = monotonic() + max_seconds if max_seconds is not None else None

    def check_time() -> None:
        nonlocal budget_exhausted
        if deadline is not None and monotonic() >= deadline:
            budget_exhausted = True
            raise _RouteBudgetReached

    zero_checked: dict[tuple[str, tuple[str, ...]], bool] = {}

    def partial_valid(engineer_id: str, order: tuple[str, ...]) -> bool:
        nonlocal zero_rejections
        check_time()
        key = (engineer_id, order)
        if key in zero_checked:
            return zero_checked[key]
        result = not any(
            engineer_id not in candidates.eligible_engineers_by_job[job_id]
            or dataset.jobs[job_id].zone_id != dataset.engineers[engineer_id].zone_id
            for job_id in order
        ) and zero_travel_order_feasible(dataset, engineer_id, order)
        zero_checked[key] = result
        if not result:
            zero_rejections += 1
        return result

    def exact_valid(engineer_id: str, order: tuple[str, ...]) -> bool:
        nonlocal route_checks, zero_rejections, budget_exhausted
        key = (engineer_id, order)
        if key in checked:
            return checked[key]
        if not order:
            checked[key] = True
            return True
        if not partial_valid(engineer_id, order):
            checked[key] = False
            return False
        if route_checks >= max_route_checks:
            budget_exhausted = True
            raise _RouteBudgetReached
        route_checks += 1
        checked[key] = route_check(engineer_id, order)
        return checked[key]

    def state_score(
        state: Mapping[str, tuple[str, ...]],
    ) -> tuple[object, ...]:
        spans = tuple(
            _zero_travel_span(dataset, engineer_id, order)
            for engineer_id, order in state.items()
        )
        used = sum(bool(order) for order in state.values())
        return (
            max(spans, default=0),
            sum(value * value for value in spans),
            sum(spans),
            used,
            tuple(sorted(state.items())),
        )

    def target_engineer(
        state: Mapping[str, tuple[str, ...]],
        target_job_id: str,
    ) -> str:
        return next(
            (
                engineer_id
                for engineer_id, order in sorted(state.items())
                if target_job_id in order
            ),
            '',
        )

    def prune_diverse(
        states: Mapping[
            tuple[tuple[str, tuple[str, ...]], ...],
            dict[str, tuple[str, ...]],
        ],
        target_job_id: str,
    ) -> list[dict[str, tuple[str, ...]]]:
        groups: dict[str, list[dict[str, tuple[str, ...]]]] = {}
        for state in states.values():
            groups.setdefault(target_engineer(state, target_job_id), []).append(state)
        for group in groups.values():
            group.sort(key=state_score)
        selected: list[dict[str, tuple[str, ...]]] = []
        group_ids = sorted(groups)
        while len(selected) < beam_width:
            progressed = False
            for group_id in group_ids:
                group = groups[group_id]
                if not group:
                    continue
                selected.append(group.pop(0))
                progressed = True
                if len(selected) >= beam_width:
                    break
            if not progressed:
                break
        return selected

    def insertion_count(
        sample_states: list[dict[str, tuple[str, ...]]],
        engineer_ids: tuple[str, ...],
        job_id: str,
    ) -> int:
        count = 0
        for state in sample_states:
            for engineer_id in engineer_ids:
                if engineer_id not in candidates.eligible_engineers_by_job[job_id]:
                    continue
                order = state[engineer_id]
                count += sum(
                    partial_valid(
                        engineer_id,
                        order[:position] + (job_id,) + order[position:],
                    )
                    for position in range(len(order) + 1)
                )
        return count

    targets = sorted(
        (job_id for job_id in unserved_job_ids if stock_allows(job_id)),
        key=lambda job_id: (
            dataset.jobs[job_id].priority != Priority.URGENT,
            len(candidates.eligible_engineers_by_job[job_id]),
            dataset.jobs[job_id].window_end,
            job_id,
        ),
    )
    try:
        for target_job_id in targets:
            check_time()
            target_engineers = tuple(sorted(
                candidates.eligible_engineers_by_job[target_job_id],
                key=lambda engineer_id: (
                    bool(routes.get(engineer_id, ())),
                    _route_window_gap(
                        dataset,
                        tuple(routes.get(engineer_id, ())),
                        target_job_id,
                    ),
                    engineer_id,
                ),
            ))
            for anchor_engineer_id in target_engineers:
                check_time()
                neighbourhoods_tried += 1
                engineer_ids = _neighbourhood_engineers(
                    dataset,
                    routes,
                    candidates,
                    target_job_id,
                    anchor_engineer_id,
                    max_engineers,
                )
                destroyed = _destroyed_jobs(
                    dataset,
                    routes,
                    engineer_ids,
                    target_job_id,
                    max_destroyed_jobs,
                    window_padding_minutes,
                    neighbour_radius,
                )
                destroyed_set = set(destroyed)
                base_routes = {
                    engineer_id: tuple(
                        job_id
                        for job_id in routes.get(engineer_id, ())
                        if job_id not in destroyed_set
                    )
                    for engineer_id in engineer_ids
                }
                pending = [target_job_id, *sorted(
                    destroyed,
                    key=lambda job_id: (
                        len(
                            set(candidates.eligible_engineers_by_job[job_id])
                            & set(engineer_ids)
                        ),
                        dataset.jobs[job_id].priority != Priority.URGENT,
                        dataset.jobs[job_id].window_end,
                        -dataset.jobs[job_id].service_duration_min,
                        job_id,
                    ),
                )]
                states: list[dict[str, tuple[str, ...]]] = [base_routes]
                while pending:
                    check_time()
                    if target_job_id in pending:
                        pending_job_id = target_job_id
                    else:
                        sample = states[: min(8, len(states))]
                        pending_job_id = min(
                            pending,
                            key=lambda job_id: (
                                insertion_count(sample, engineer_ids, job_id),
                                len(
                                    set(candidates.eligible_engineers_by_job[job_id])
                                    & set(engineer_ids)
                                ),
                                dataset.jobs[job_id].priority != Priority.URGENT,
                                dataset.jobs[job_id].window_end,
                                job_id,
                            ),
                        )
                    pending.remove(pending_job_id)
                    next_states: dict[
                        tuple[tuple[str, tuple[str, ...]], ...],
                        dict[str, tuple[str, ...]],
                    ] = {}
                    for state in states:
                        check_time()
                        for engineer_id in engineer_ids:
                            if (
                                engineer_id
                                not in candidates.eligible_engineers_by_job[pending_job_id]
                            ):
                                continue
                            old_order = state[engineer_id]
                            for position in range(len(old_order) + 1):
                                expanded_states += 1
                                trial = (
                                    old_order[:position]
                                    + (pending_job_id,)
                                    + old_order[position:]
                                )
                                if not partial_valid(engineer_id, trial):
                                    continue
                                new_state = dict(state)
                                new_state[engineer_id] = trial
                                signature = tuple(sorted(new_state.items()))
                                next_states.setdefault(signature, new_state)
                    if not next_states:
                        states = []
                        break
                    states = prune_diverse(next_states, target_job_id)
                for state in sorted(states, key=state_score):
                    check_time()
                    complete_states_checked += 1
                    if not all(
                        exact_valid(engineer_id, order)
                        for engineer_id, order in state.items()
                    ):
                        continue
                    changed = {
                        engineer_id: order
                        for engineer_id, order in state.items()
                        if order != tuple(routes.get(engineer_id, ()))
                    }
                    if not changed:
                        continue
                    assigned = {
                        job_id for order in state.values() for job_id in order
                    }
                    expected = destroyed_set | {target_job_id}
                    if not expected <= assigned:
                        continue
                    return ExactLnsSearchReport(
                        ExactLnsMove(
                            target_job_id,
                            changed,
                            destroyed,
                            engineer_ids,
                        ),
                        route_checks,
                        expanded_states,
                        zero_rejections,
                        neighbourhoods_tried,
                        complete_states_checked,
                        budget_exhausted,
                    )
    except _RouteBudgetReached:
        pass
    return ExactLnsSearchReport(
        None,
        route_checks,
        expanded_states,
        zero_rejections,
        neighbourhoods_tried,
        complete_states_checked,
        budget_exhausted,
    )
