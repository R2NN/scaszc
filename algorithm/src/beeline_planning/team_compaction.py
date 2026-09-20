"""Coverage-preserving elimination of complete engineer routes."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Callable, Mapping

from .domain import PlanningDataset
from .eligibility import CandidateIndex
from .screening import ScreeningMatrices


@dataclass(frozen=True, slots=True, order=True)
class RouteEvaluation:
    """Screening cost of one feasible ordered engineer route."""

    route_minutes: int
    travel_minutes: int
    waiting_minutes: int


@dataclass(frozen=True, slots=True)
class TeamEliminationCandidate:
    """A complete reassignment that leaves one previously used engineer idle."""

    eliminated_engineer_id: str
    moved_job_ids: tuple[str, ...]
    changed_routes: tuple[tuple[str, tuple[str, ...]], ...]
    screening_score: tuple[int, int, int]

    def route_updates(self) -> dict[str, tuple[str, ...]]:
        """Return the changed target routes as a mutable mapping."""
        return dict(self.changed_routes)


@dataclass(frozen=True, slots=True)
class TeamEliminationSearchReport:
    """Bounded screening search result for route elimination."""

    candidates: tuple[TeamEliminationCandidate, ...]
    evaluated_route_orders: int
    expanded_states: int
    budget_exhausted: bool


RouteEvaluator = Callable[[str, tuple[str, ...]], RouteEvaluation | None]


def build_screening_route_evaluator(
    dataset: PlanningDataset,
    screening: ScreeningMatrices,
    candidates: CandidateIndex,
) -> RouteEvaluator:
    """Build an earliest-schedule evaluator matching the master constraints."""

    cache: dict[tuple[str, tuple[str, ...]], RouteEvaluation | None] = {}

    def evaluate(
        engineer_id: str,
        order: tuple[str, ...],
    ) -> RouteEvaluation | None:
        key = (engineer_id, order)
        if key in cache:
            return cache[key]
        engineer = dataset.engineers[engineer_id]
        if len(order) > engineer.max_jobs:
            cache[key] = None
            return None
        if not order:
            result = RouteEvaluation(0, 0, 0)
            cache[key] = result
            return result
        first_job = dataset.jobs[order[0]]
        moment = max(
            dataset.initial_planning_at,
            engineer.shift_start,
            first_job.created_at,
        )
        route_start = moment
        previous_location_id = dataset.offices[
            engineer.start_office_id
        ].location_id
        travel_minutes = 0
        waiting_minutes = 0
        for job_id in order:
            if engineer_id not in candidates.eligible_engineers_by_job[job_id]:
                cache[key] = None
                return None
            job = dataset.jobs[job_id]
            if job.zone_id != engineer.zone_id:
                cache[key] = None
                return None
            duration = (
                0
                if previous_location_id == job.location_id
                else screening.estimate(
                    engineer.zone_id,
                    engineer.transport_mode,
                    previous_location_id,
                    job.location_id,
                ).duration_minutes
            )
            arrival = moment + timedelta(minutes=duration)
            service_start = max(arrival, job.window_start, job.created_at)
            service_end = service_start + timedelta(
                minutes=job.service_duration_min
            )
            if (
                service_start > job.window_end
                or service_end > engineer.shift_end
                or service_end - route_start
                > timedelta(minutes=engineer.max_route_minutes)
            ):
                cache[key] = None
                return None
            travel_minutes += duration
            waiting_minutes += int((service_start - arrival).total_seconds() // 60)
            moment = service_end
            previous_location_id = job.location_id
        result = RouteEvaluation(
            int((moment - route_start).total_seconds() // 60),
            travel_minutes,
            waiting_minutes,
        )
        cache[key] = result
        return result

    return evaluate


def find_team_elimination_candidates(
    dataset: PlanningDataset,
    routes: Mapping[str, tuple[str, ...]],
    candidates: CandidateIndex,
    evaluate_route: RouteEvaluator,
    *,
    beam_width: int = 64,
    max_candidates: int = 30,
    max_candidates_per_source: int = 3,
    max_states: int = 100_000,
    focus_engineer_id: str | None = None,
) -> TeamEliminationSearchReport:
    """Find bounded screening-feasible ways to remove one used engineer.

    Jobs may move only to engineers that are already used in the incumbent.
    Consequently every returned candidate uses exactly one fewer team while
    preserving the incumbent's served-job set.
    """

    if (
        beam_width < 1
        or max_candidates < 1
        or max_candidates_per_source < 1
        or max_states < 1
    ):
        raise ValueError('Search budgets must be positive')
    used_routes = {
        engineer_id: tuple(order)
        for engineer_id, order in routes.items()
        if order
    }
    if focus_engineer_id is not None:
        if focus_engineer_id not in used_routes:
            raise ValueError('Focused engineer must have a non-empty incumbent route')
        source_ids = (focus_engineer_id,)
    else:
        source_ids = tuple(sorted(
            used_routes,
            key=lambda engineer_id: (
                len(used_routes[engineer_id]),
                sum(
                    dataset.jobs[job_id].service_duration_min
                    for job_id in used_routes[engineer_id]
                ),
                engineer_id,
            ),
        ))
    evaluation_cache: dict[
        tuple[str, tuple[str, ...]],
        RouteEvaluation | None,
    ] = {}
    evaluated_route_orders = 0

    def evaluate(
        engineer_id: str,
        order: tuple[str, ...],
    ) -> RouteEvaluation | None:
        nonlocal evaluated_route_orders
        key = (engineer_id, order)
        if key not in evaluation_cache:
            evaluation_cache[key] = evaluate_route(engineer_id, order)
            evaluated_route_orders += 1
        return evaluation_cache[key]

    found: list[TeamEliminationCandidate] = []
    seen_candidates: set[tuple[tuple[str, tuple[str, ...]], ...]] = set()
    expanded_states = 0
    budget_exhausted = False
    for source_id in source_ids:
        source_candidate_count = 0
        source_jobs = used_routes[source_id]
        source_zone = dataset.engineers[source_id].zone_id
        target_ids = tuple(sorted(
            engineer_id
            for engineer_id in used_routes
            if engineer_id != source_id
            and dataset.engineers[engineer_id].zone_id == source_zone
        ))
        if not target_ids or any(
            not any(
                target_id in candidates.eligible_engineers_by_job[job_id]
                for target_id in target_ids
            )
            for job_id in source_jobs
        ):
            continue
        ordered_jobs = tuple(sorted(
            source_jobs,
            key=lambda job_id: (
                sum(
                    target_id in candidates.eligible_engineers_by_job[job_id]
                    for target_id in target_ids
                ),
                dataset.jobs[job_id].window_end,
                -dataset.jobs[job_id].service_duration_min,
                job_id,
            ),
        ))
        initial_routes = {
            target_id: used_routes[target_id] for target_id in target_ids
        }
        initial_evaluations = {
            target_id: evaluate(target_id, order)
            for target_id, order in initial_routes.items()
        }
        if any(value is None for value in initial_evaluations.values()):
            continue
        # A beam state stores its accumulated marginal cost and all target
        # routes.  Keeping multiple states is important: a locally cheap insert
        # can consume the only later window for a more constrained job.
        states: list[
            tuple[tuple[int, int, int], dict[str, tuple[str, ...]]]
        ] = [((0, 0, 0), initial_routes)]
        for job_id in ordered_jobs:
            next_states: list[
                tuple[tuple[int, int, int], dict[str, tuple[str, ...]]]
            ] = []
            seen_states: set[tuple[tuple[str, tuple[str, ...]], ...]] = set()
            for accumulated, state_routes in states:
                if expanded_states >= max_states:
                    budget_exhausted = True
                    break
                expanded_states += 1
                for target_id in target_ids:
                    if target_id not in candidates.eligible_engineers_by_job[job_id]:
                        continue
                    old_order = state_routes[target_id]
                    old_score = evaluate(target_id, old_order)
                    if old_score is None:
                        continue
                    for position in range(len(old_order) + 1):
                        trial = (
                            old_order[:position]
                            + (job_id,)
                            + old_order[position:]
                        )
                        new_score = evaluate(target_id, trial)
                        if new_score is None:
                            continue
                        new_routes = dict(state_routes)
                        new_routes[target_id] = trial
                        signature = tuple(sorted(new_routes.items()))
                        if signature in seen_states:
                            continue
                        seen_states.add(signature)
                        marginal = (
                            new_score.route_minutes - old_score.route_minutes,
                            new_score.travel_minutes - old_score.travel_minutes,
                            new_score.waiting_minutes - old_score.waiting_minutes,
                        )
                        total = tuple(
                            accumulated[index] + marginal[index]
                            for index in range(3)
                        )
                        next_states.append((total, new_routes))
            if budget_exhausted or not next_states:
                states = []
                break
            next_states.sort(key=lambda item: (
                item[0],
                tuple(sorted(item[1].items())),
            ))
            states = next_states[:beam_width]
        for screening_score, final_routes in states:
            changed = tuple(sorted(
                (engineer_id, order)
                for engineer_id, order in final_routes.items()
                if order != used_routes[engineer_id]
            ))
            if not changed or changed in seen_candidates:
                continue
            seen_candidates.add(changed)
            found.append(TeamEliminationCandidate(
                eliminated_engineer_id=source_id,
                moved_job_ids=source_jobs,
                changed_routes=changed,
                screening_score=screening_score,
            ))
            source_candidate_count += 1
            if len(found) >= max_candidates:
                return TeamEliminationSearchReport(
                    tuple(found),
                    evaluated_route_orders,
                    expanded_states,
                    budget_exhausted,
                )
            if source_candidate_count >= max_candidates_per_source:
                break
        if budget_exhausted:
            break
    return TeamEliminationSearchReport(
        tuple(found),
        evaluated_route_orders,
        expanded_states,
        budget_exhausted,
    )
