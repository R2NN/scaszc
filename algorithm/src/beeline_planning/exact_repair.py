from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import timedelta
from itertools import combinations
from time import monotonic
from typing import Callable, Mapping

from .domain import PlanningDataset, Priority
from .eligibility import CandidateIndex
from .solver import (
    MasterEngineerRoute,
    MasterSolution,
    MasterSolveStatus,
    MasterVisit,
)


RouteCheck = Callable[[str, tuple[str, ...]], bool]


class _BudgetReached(Exception):
    pass


class _DepthBudgetReached(Exception):
    pass


class _JobBudgetReached(Exception):
    pass


@dataclass(frozen=True, slots=True)
class RepairMove:
    """One coverage-increasing change, with every affected route represented."""

    inserted_job_id: str
    kind: str
    routes: Mapping[str, tuple[str, ...]]
    displaced_job_ids: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class RepairSearchReport:
    move: RepairMove | None
    route_checks: int
    route_checks_by_depth: tuple[int, ...]
    route_checks_by_job: Mapping[str, int]
    zero_travel_rejections: int
    budget_exhausted: bool


@dataclass(frozen=True, slots=True)
class UrgentExchangeMove:
    """Assign an urgent job by releasing lower-priority work on one route."""

    inserted_job_id: str
    routes: Mapping[str, tuple[str, ...]]
    released_normal_job_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class UrgentExchangeReport:
    move: UrgentExchangeMove | None
    route_checks: int
    budget_exhausted: bool


def master_from_orders(
    dataset: PlanningDataset,
    routes: Mapping[str, tuple[str, ...]],
    unserved_job_ids: set[str],
) -> MasterSolution:
    """Build an explicitly unproven route-order proposal for exact validation."""
    master_routes: list[MasterEngineerRoute] = []
    for engineer_id, job_ids in sorted(routes.items()):
        if not job_ids:
            continue
        engineer = dataset.engineers[engineer_id]
        visits = tuple(
            MasterVisit(
                sequence=index + 1,
                job_id=job_id,
                origin_node_id=(
                    f'START:{engineer_id}' if index == 0 else job_ids[index - 1]
                ),
                departure_at=max(dataset.initial_planning_at, engineer.shift_start),
                service_start_at=dataset.jobs[job_id].window_start,
                screening_duration_minutes=0,
                screening_distance_m=0,
                screening_source_mode=engineer.transport_mode.value,
                screening_is_surrogate=False,
            )
            for index, job_id in enumerate(job_ids)
        )
        master_routes.append(MasterEngineerRoute(engineer_id, visits))
    return MasterSolution(
        status=MasterSolveStatus.SCREENING_FEASIBLE,
        planning_at=dataset.initial_planning_at,
        routes=tuple(master_routes),
        unserved_job_ids=tuple(sorted(unserved_job_ids)),
        objective_proofs=(),
        dataset_sha256=dataset.dataset_sha256,
        screening_snapshot_sha256='0' * 64,
        solver_version='exact-coverage-repair',
        search_graph_complete=False,
        searched_arc_count=0,
        operationally_excluded_arcs=(),
    )


def zero_travel_order_feasible(
    dataset: PlanningDataset,
    engineer_id: str,
    job_ids: tuple[str, ...],
) -> bool:
    """Safely reject an order only if even zero-minute travel cannot fit it."""
    engineer = dataset.engineers[engineer_id]
    if len(job_ids) > engineer.max_jobs:
        return False
    first_departure = max(
        dataset.initial_planning_at,
        engineer.shift_start,
        dataset.jobs[job_ids[0]].created_at if job_ids else engineer.shift_start,
    )
    moment = first_departure
    for job_id in job_ids:
        job = dataset.jobs[job_id]
        if job.zone_id != engineer.zone_id:
            return False
        moment = max(moment, job.created_at, job.window_start)
        if moment > job.window_end:
            return False
        moment += timedelta(minutes=job.service_duration_min)
        if moment > engineer.shift_end:
            return False
    return not job_ids or moment - first_departure <= timedelta(
        minutes=engineer.max_route_minutes
    )


def find_urgent_exchange_move(
    dataset: PlanningDataset,
    routes: Mapping[str, tuple[str, ...]],
    unserved_job_ids: set[str],
    candidates: CandidateIndex,
    route_check: RouteCheck,
    *,
    max_released_normals: int = 2,
    max_route_checks: int = 400,
    max_seconds: float | None = None,
) -> UrgentExchangeReport:
    """Prefer an urgent job when exact capacity requires releasing normal work.

    The caller must validate the complete changed plan. A failed bounded search
    does not prove the urgent job impossible.
    """
    if not 1 <= max_released_normals <= 3 or max_route_checks < 1:
        raise ValueError('Invalid urgent exchange search limits')
    if max_seconds is not None and max_seconds <= 0:
        raise ValueError('max_seconds must be positive')
    urgent_ids = sorted(
        (job_id for job_id in unserved_job_ids
         if dataset.jobs[job_id].priority == Priority.URGENT),
        key=lambda job_id: (
            dataset.jobs[job_id].window_end,
            len(candidates.eligible_engineers_by_job[job_id]), job_id,
        ),
    )
    if not urgent_ids:
        return UrgentExchangeReport(None, 0, False)
    deadline = monotonic() + max_seconds if max_seconds is not None else None
    checks = 0
    committed = {
        commitment.job_id
        for commitment in dataset.active_commitments_at(dataset.initial_planning_at)
    }
    stock = {
        (item.zone_id, item.equipment_id): item.quantity_available
        for item in dataset.shared_inventory
    }
    used: Counter[tuple[str, str]] = Counter()

    def shared_needs(job_id: str) -> Counter[tuple[str, str]]:
        job = dataset.jobs[job_id]
        needs: Counter[tuple[str, str]] = Counter()
        for need in job.required_equipment:
            if dataset.equipment_catalog[need.equipment_id].shared_stock:
                needs[job.zone_id, need.equipment_id] += need.quantity
        return needs

    for order in routes.values():
        for job_id in order:
            used.update(shared_needs(job_id))

    for release_count in range(1, max_released_normals + 1):
        for urgent_id in urgent_ids:
            urgent = dataset.jobs[urgent_id]
            engineer_ids = sorted(
                candidates.eligible_engineers_by_job[urgent_id],
                key=lambda engineer_id: (
                    len(routes.get(engineer_id, ())), engineer_id,
                ),
            )
            for engineer_id in engineer_ids:
                if dataset.engineers[engineer_id].zone_id != urgent.zone_id:
                    continue
                order = tuple(routes.get(engineer_id, ()))
                releasable = sorted(
                    (job_id for job_id in order
                     if dataset.jobs[job_id].priority == Priority.NORMAL
                     and job_id not in committed),
                    key=lambda job_id: (
                        not (
                            dataset.jobs[job_id].window_start <= urgent.window_end
                            and urgent.window_start <= dataset.jobs[job_id].window_end
                        ),
                        job_id,
                    ),
                )
                for released in combinations(releasable, release_count):
                    released_stock: Counter[tuple[str, str]] = Counter()
                    for job_id in released:
                        released_stock.update(shared_needs(job_id))
                    if any(
                        used[key] - released_stock[key] + quantity
                        > stock.get(key, 0)
                        for key, quantity in shared_needs(urgent_id).items()
                    ):
                        continue
                    reduced = tuple(job_id for job_id in order if job_id not in released)
                    for position in range(len(reduced) + 1):
                        if deadline is not None and monotonic() >= deadline:
                            return UrgentExchangeReport(None, checks, True)
                        proposal = (
                            reduced[:position] + (urgent_id,) + reduced[position:]
                        )
                        if not zero_travel_order_feasible(dataset, engineer_id, proposal):
                            continue
                        if checks >= max_route_checks:
                            return UrgentExchangeReport(None, checks, True)
                        checks += 1
                        if route_check(engineer_id, proposal):
                            return UrgentExchangeReport(
                                UrgentExchangeMove(
                                    urgent_id, {engineer_id: proposal},
                                    tuple(sorted(released)),
                                ),
                                checks, False,
                            )
    return UrgentExchangeReport(None, checks, False)


def find_coverage_move(
    dataset: PlanningDataset,
    routes: Mapping[str, tuple[str, ...]],
    unserved_job_ids: set[str],
    candidates: CandidateIndex,
    route_check: RouteCheck,
    *,
    max_route_checks: int = 400,
    max_displacements: int = 2,
    max_checks_by_depth: tuple[int, ...] | None = None,
    reorder_affected_routes: bool = False,
    max_seconds: float | None = None,
) -> RepairSearchReport:
    """Find a direct insert or a bounded exact ejection chain.

    `route_check` must verify the proposed single route with exact travel. The
    caller still has to validate the complete plan before publishing a move.
    Search limits bound effort, so a missing move is never an infeasibility proof.
    """
    if max_route_checks < 1:
        raise ValueError('max_route_checks must be positive')
    if max_seconds is not None and max_seconds <= 0:
        raise ValueError('max_seconds must be positive')
    if not 0 <= max_displacements <= 4:
        raise ValueError('max_displacements must be between 0 and 4')
    if not unserved_job_ids:
        return RepairSearchReport(
            None, 0, (0,) * (max_displacements + 1), {}, 0, False
        )
    if max_checks_by_depth is None:
        weights = tuple(range(1, max_displacements + 2))
        if max_route_checks < len(weights):
            allocated = [1] * len(weights)
        else:
            weight_total = sum(weights)
            allocated = [
                max(1, max_route_checks * weight // weight_total)
                for weight in weights
            ]
            allocated[-1] += max(0, max_route_checks - sum(allocated))
        max_checks_by_depth = tuple(allocated)
    if (
        len(max_checks_by_depth) != max_displacements + 1
        or any(limit < 1 for limit in max_checks_by_depth)
    ):
        raise ValueError('max_checks_by_depth must have one positive limit per depth')

    exact_checks = 0
    checks_by_depth = [0] * (max_displacements + 1)
    checks_by_job: dict[str, int] = {}
    checks_by_job_depth: dict[tuple[int, str], int] = {}
    zero_rejections = 0
    budget_exhausted = False
    deadline = monotonic() + max_seconds if max_seconds is not None else None
    active_depth = 0
    active_job_id = ''
    checked: dict[tuple[str, tuple[str, ...]], bool] = {
        (engineer_id, tuple(job_ids)): True
        for engineer_id, job_ids in routes.items()
    }

    def valid(engineer_id: str, order: tuple[str, ...]) -> bool:
        nonlocal exact_checks, zero_rejections, budget_exhausted
        if deadline is not None and monotonic() >= deadline:
            budget_exhausted = True
            raise _BudgetReached
        key = (engineer_id, order)
        if key in checked:
            return checked[key]
        if not zero_travel_order_feasible(dataset, engineer_id, order):
            zero_rejections += 1
            checked[key] = False
            return False
        if exact_checks >= max_route_checks:
            budget_exhausted = True
            raise _BudgetReached
        if (
            checks_by_depth[active_depth] >= max_checks_by_depth[active_depth]
        ):
            budget_exhausted = True
            raise _DepthBudgetReached
        job_limit = max(
            1,
            (max_checks_by_depth[active_depth] + len(urgent_first) - 1)
            // len(urgent_first),
        )
        if checks_by_job_depth.get((active_depth, active_job_id), 0) >= job_limit:
            budget_exhausted = True
            raise _JobBudgetReached
        exact_checks += 1
        checks_by_depth[active_depth] += 1
        checks_by_job[active_job_id] = checks_by_job.get(active_job_id, 0) + 1
        depth_job_key = (active_depth, active_job_id)
        checks_by_job_depth[depth_job_key] = (
            checks_by_job_depth.get(depth_job_key, 0) + 1
        )
        checked[key] = route_check(engineer_id, order)
        return checked[key]

    def placements(
        engineer_id: str,
        order: tuple[str, ...],
        job_id: str,
        *,
        allow_reorder: bool = True,
    ):
        if engineer_id not in candidates.eligible_engineers_by_job[job_id]:
            return
        # This explicit check protects the geographic rule even if a caller
        # supplies a malformed candidate index.
        if dataset.engineers[engineer_id].zone_id != dataset.jobs[job_id].zone_id:
            return
        seen: set[tuple[str, ...]] = set()
        direct_orders = tuple(
            order[:position] + (job_id,) + order[position:]
            for position in range(len(order) + 1)
        )
        for trial in direct_orders:
            seen.add(trial)
            if valid(engineer_id, trial):
                yield trial
        if not reorder_affected_routes or not allow_reorder:
            return

        # A coverage repair can require changing the order of visits that were
        # already assigned to the route.  The previous search only inserted the
        # pending job into the existing order, so a feasible move was invisible
        # whenever one neighbouring visit also had to move.  Explore the bounded
        # one-relocation neighbourhood for every direct insertion.  This keeps
        # the search finite while allowing the exact checker, not the screening
        # estimate, to decide which order is operationally valid.
        for direct in direct_orders:
            for source in range(len(direct)):
                if direct[source] == job_id:
                    continue
                reduced = direct[:source] + direct[source + 1:]
                for destination in range(len(reduced) + 1):
                    trial = (
                        reduced[:destination]
                        + (direct[source],)
                        + reduced[destination:]
                    )
                    if trial in seen:
                        continue
                    seen.add(trial)
                    if valid(engineer_id, trial):
                        yield trial

    stock_available = {
        (item.zone_id, item.equipment_id): item.quantity_available
        for item in dataset.shared_inventory
    }
    stock_used: Counter[tuple[str, str]] = Counter()
    for order in routes.values():
        for assigned_job_id in order:
            assigned_job = dataset.jobs[assigned_job_id]
            for need in assigned_job.required_equipment:
                if dataset.equipment_catalog[need.equipment_id].shared_stock:
                    stock_used[assigned_job.zone_id, need.equipment_id] += need.quantity

    def stock_allows(job_id: str) -> bool:
        job = dataset.jobs[job_id]
        return all(
            not dataset.equipment_catalog[need.equipment_id].shared_stock
            or stock_used[job.zone_id, need.equipment_id] + need.quantity
            <= stock_available.get((job.zone_id, need.equipment_id), 0)
            for need in job.required_equipment
        )

    urgent_first = sorted(
        (job_id for job_id in unserved_job_ids if stock_allows(job_id)),
        key=lambda job_id: (
            dataset.jobs[job_id].priority != Priority.URGENT,
            len(candidates.eligible_engineers_by_job[job_id]),
            dataset.jobs[job_id].window_end,
            job_id,
        ),
    )

    def search_depth(depth: int) -> RepairMove | None:
        nonlocal active_job_id
        for job_id in urgent_first:
            active_job_id = job_id
            try:
                move = search_job_at_depth(job_id, depth)
            except _JobBudgetReached:
                continue
            if move is not None:
                return move
        return None

    def search_job_at_depth(job_id: str, depth: int) -> RepairMove | None:
        original_routes = {
            engineer_id: tuple(order)
            for engineer_id, order in routes.items()
        }

        def continue_chain(
            pending_job_id: str,
            current_routes: Mapping[str, tuple[str, ...]],
            remaining_displacements: int,
            displaced_job_ids: tuple[str, ...],
        ) -> tuple[dict[str, tuple[str, ...]], tuple[str, ...]] | None:
            nonlocal budget_exhausted
            if deadline is not None and monotonic() >= deadline:
                budget_exhausted = True
                raise _BudgetReached
            protected_jobs = {job_id, *displaced_job_ids}
            target_ids = sorted(
                candidates.eligible_engineers_by_job[pending_job_id],
                key=lambda engineer_id: (
                    len(current_routes.get(engineer_id, ())),
                    engineer_id,
                ),
            )
            if not displaced_job_ids and remaining_displacements == 0:
                # Give every eligible engineer a cheap direct insertion before
                # spending the deadline on route reorderings for one engineer.
                for allow_reorder in (False, True):
                    if allow_reorder and not reorder_affected_routes:
                        break
                    for target_id in target_ids:
                        target_order = tuple(current_routes.get(target_id, ()))
                        for new_target in placements(
                            target_id, target_order, pending_job_id,
                            allow_reorder=allow_reorder,
                        ):
                            completed = dict(current_routes)
                            completed[target_id] = new_target
                            return completed, displaced_job_ids
                return None

            for target_id in target_ids:
                target_order = tuple(current_routes.get(target_id, ()))
                # At the root of a positive-depth search, direct insertion was
                # already exhausted by the preceding depth.  Repeating it here
                # is especially expensive when route reordering is enabled.
                # A displaced job, however, must still be inserted directly to
                # terminate the ejection chain.
                if displaced_job_ids or remaining_displacements == 0:
                    for new_target in placements(
                        target_id,
                        target_order,
                        pending_job_id,
                    ):
                        completed = dict(current_routes)
                        completed[target_id] = new_target
                        return completed, displaced_job_ids

                if remaining_displacements == 0:
                    continue
                pending = dataset.jobs[pending_job_id]
                displacement_order = sorted(
                    target_order,
                    key=lambda assigned_job_id: (
                        # Jobs whose windows overlap the pending job are the
                        # most likely source of the local capacity conflict.
                        not (
                            dataset.jobs[assigned_job_id].window_start
                            <= pending.window_end
                            and pending.window_start
                            <= dataset.jobs[assigned_job_id].window_end
                        ),
                        len(candidates.eligible_engineers_by_job[assigned_job_id]),
                        dataset.jobs[assigned_job_id].window_end,
                        assigned_job_id,
                    ),
                )
                for displaced_job_id in displacement_order:
                    if displaced_job_id in protected_jobs:
                        continue
                    reduced_target = tuple(
                        assigned_job_id
                        for assigned_job_id in target_order
                        if assigned_job_id != displaced_job_id
                    )
                    for new_target in placements(
                        target_id,
                        reduced_target,
                        pending_job_id,
                    ):
                        next_routes = dict(current_routes)
                        next_routes[target_id] = new_target
                        result = continue_chain(
                            displaced_job_id,
                            next_routes,
                            remaining_displacements - 1,
                            displaced_job_ids + (displaced_job_id,),
                        )
                        if result is not None:
                            return result
            return None

        result = continue_chain(job_id, original_routes, depth, ())
        if result is None:
            return None
        completed_routes, displaced_job_ids = result
        changed_routes = {
            engineer_id: order
            for engineer_id, order in completed_routes.items()
            if order != original_routes.get(engineer_id, ())
        }
        if not displaced_job_ids:
            kind = 'DIRECT_INSERT'
        elif len(displaced_job_ids) == 1:
            kind = 'RELOCATE'
        elif len(displaced_job_ids) == 2 and len(changed_routes) == 2:
            kind = 'SWAP'
        else:
            kind = 'EJECTION_CHAIN'
        return RepairMove(
            job_id,
            kind,
            changed_routes,
            displaced_job_ids,
        )

    try:
        for depth in range(max_displacements + 1):
            active_depth = depth
            try:
                move = search_depth(depth)
            except _DepthBudgetReached:
                continue
            if move is not None:
                return RepairSearchReport(
                    move, exact_checks, tuple(checks_by_depth),
                    dict(checks_by_job),
                    zero_rejections, budget_exhausted,
                )
    except _BudgetReached:
        pass

    return RepairSearchReport(
        None, exact_checks, tuple(checks_by_depth),
        dict(checks_by_job),
        zero_rejections, budget_exhausted,
    )
