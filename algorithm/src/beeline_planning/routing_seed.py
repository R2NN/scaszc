from __future__ import annotations

from datetime import datetime, timedelta
from importlib.metadata import version

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from .domain import PlanningDataset
from .master import MasterModelInput
from .screening import ScreeningMatrices
from .solver import (
    MasterEngineerRoute,
    MasterSolution,
    MasterSolveStatus,
    MasterVisit,
)


def _minute(day_start: datetime, value: datetime) -> int:
    return int((value - day_start).total_seconds() // 60)


def build_full_coverage_routing_seed(
    dataset: PlanningDataset,
    master: MasterModelInput,
    screening: ScreeningMatrices,
    *,
    max_seconds: int = 120,
    random_seed: int = 20260918,
    forbidden_job_arcs: tuple[tuple[str, str], ...] = (),
    allow_intermediate_omissions: bool = True,
    stop_at_full_coverage: bool = True,
) -> MasterSolution:
    """Build a mandatory-coverage VRPTW seed for the exact CP-SAT model.

    This search is deliberately not publishable: screening travel is not exact
    for time-dependent transport. Its only purpose is to provide a strong full
    route-order incumbent that the exact materializer and CP-SAT can verify.
    """
    if max_seconds < 1:
        raise ValueError('max_seconds must be positive')
    active_job_ids = tuple(master.candidate_index.active_job_ids)
    engineer_ids = tuple(sorted(dataset.engineers))
    job_node = {job_id: index for index, job_id in enumerate(active_job_ids)}
    node_job = {index: job_id for job_id, index in job_node.items()}
    office_ids = tuple(sorted({
        dataset.engineers[engineer_id].start_office_id
        for engineer_id in engineer_ids
    }))
    office_node = {
        office_id: len(job_node) + index
        for index, office_id in enumerate(office_ids)
    }
    end_node = len(job_node) + len(office_node)
    starts = [
        office_node[dataset.engineers[engineer_id].start_office_id]
        for engineer_id in engineer_ids
    ]
    ends = [end_node] * len(engineer_ids)
    manager = pywrapcp.RoutingIndexManager(
        end_node + 1,
        len(engineer_ids),
        starts,
        ends,
    )
    routing = pywrapcp.RoutingModel(manager)
    day_start = master.planning_at.replace(hour=0, minute=0, second=0, microsecond=0)
    arcs_by_key = {
        (arc.engineer_id, arc.origin_node_id, arc.destination_job_id): arc
        for arc in master.arcs
    }

    def location_id(node: int) -> str | None:
        if node in node_job:
            return dataset.jobs[node_job[node]].location_id
        for office_id, candidate_node in office_node.items():
            if candidate_node == node:
                return dataset.offices[office_id].location_id
        return None

    time_callbacks: list[int] = []
    distance_callbacks: list[int] = []
    for vehicle, engineer_id in enumerate(engineer_ids):
        engineer = dataset.engineers[engineer_id]

        def time_callback(from_index: int, to_index: int, *, _engineer=engineer) -> int:
            from_node = manager.IndexToNode(from_index)
            to_node = manager.IndexToNode(to_index)
            service = (
                dataset.jobs[node_job[from_node]].service_duration_min
                if from_node in node_job
                else 0
            )
            if to_node == end_node:
                return service
            if to_node not in node_job:
                return service
            origin_node_id = (
                node_job[from_node]
                if from_node in node_job
                else f'START:{_engineer.engineer_id}'
            )
            arc = arcs_by_key.get(
                (_engineer.engineer_id, origin_node_id, node_job[to_node])
            )
            return service + (arc.screening_duration_minutes if arc else horizon)

        def distance_callback(from_index: int, to_index: int, *, _engineer=engineer) -> int:
            from_node = manager.IndexToNode(from_index)
            to_node = manager.IndexToNode(to_index)
            if to_node == end_node:
                return 0
            if to_node not in node_job:
                return 0
            origin_node_id = (
                node_job[from_node]
                if from_node in node_job
                else f'START:{_engineer.engineer_id}'
            )
            arc = arcs_by_key.get(
                (_engineer.engineer_id, origin_node_id, node_job[to_node])
            )
            return arc.screening_distance_m if arc else 1_000_000_000

        time_index = routing.RegisterTransitCallback(time_callback)
        distance_index = routing.RegisterTransitCallback(distance_callback)
        time_callbacks.append(time_index)
        distance_callbacks.append(distance_index)
        routing.SetArcCostEvaluatorOfVehicle(distance_index, vehicle)
        routing.SetFixedCostOfVehicle(1_000_000_000, vehicle)

    horizon = max(_minute(day_start, engineer.shift_end) for engineer in dataset.engineers.values())
    routing.AddDimensionWithVehicleTransits(
        time_callbacks,
        horizon,
        horizon,
        False,
        'Time',
    )
    time_dimension = routing.GetDimensionOrDie('Time')
    for vehicle, engineer_id in enumerate(engineer_ids):
        engineer = dataset.engineers[engineer_id]
        start_index = routing.Start(vehicle)
        end_index = routing.End(vehicle)
        time_dimension.CumulVar(start_index).SetRange(
            _minute(day_start, max(master.planning_at, engineer.shift_start)),
            _minute(day_start, engineer.shift_end),
        )
        time_dimension.CumulVar(end_index).SetRange(
            _minute(day_start, max(master.planning_at, engineer.shift_start)),
            _minute(day_start, engineer.shift_end),
        )
        time_dimension.SetSpanUpperBoundForVehicle(
            engineer.max_route_minutes,
            vehicle,
        )
        routing.AddVariableMinimizedByFinalizer(time_dimension.CumulVar(start_index))
        routing.AddVariableMinimizedByFinalizer(time_dimension.CumulVar(end_index))

    for job_id, node in job_node.items():
        job = dataset.jobs[job_id]
        index = manager.NodeToIndex(node)
        time_dimension.CumulVar(index).SetRange(
            _minute(day_start, max(master.planning_at, job.created_at, job.window_start)),
            _minute(day_start, job.window_end),
        )
        allowed = [
            engineer_ids.index(engineer_id)
            for engineer_id in master.candidate_index.eligible_engineers_by_job[job_id]
        ]
        routing.VehicleVar(index).SetValues([-1, *allowed])
        # The search may cross incomplete intermediate states, but one omitted
        # job costs far more than every vehicle and all travel combined.
        if allow_intermediate_omissions:
            routing.AddDisjunction([index], 1_000_000_000_000)

    for origin_job_id, destination_job_id in forbidden_job_arcs:
        if origin_job_id not in job_node or destination_job_id not in job_node:
            raise ValueError(
                f'Forbidden routing-seed arc contains an unknown job: '
                f'{origin_job_id} -> {destination_job_id}'
            )
        origin_index = manager.NodeToIndex(job_node[origin_job_id])
        destination_index = manager.NodeToIndex(job_node[destination_job_id])
        routing.NextVar(origin_index).RemoveValue(destination_index)

    def job_count(from_index: int) -> int:
        return int(manager.IndexToNode(from_index) in node_job)

    count_callback = routing.RegisterUnaryTransitCallback(job_count)
    routing.AddDimensionWithVehicleCapacity(
        count_callback,
        0,
        [dataset.engineers[engineer_id].max_jobs for engineer_id in engineer_ids],
        True,
        'JobCount',
    )
    engineer_index = {engineer_id: index for index, engineer_id in enumerate(engineer_ids)}
    for committed_engineer_id, job_id in master.hard_assignments:
        routing.VehicleVar(manager.NodeToIndex(job_node[job_id])).SetValue(
            engineer_index[committed_engineer_id]
        )

    parameters = pywrapcp.DefaultRoutingSearchParameters()
    parameters.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    )
    parameters.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    parameters.time_limit.seconds = max_seconds
    parameters.log_search = False
    parameters.sat_parameters.random_seed = random_seed
    if stop_at_full_coverage and allow_intermediate_omissions:
        job_indices = tuple(
            manager.NodeToIndex(node) for node in job_node.values()
        )

        def stop_after_first_full_solution() -> None:
            if all(routing.ActiveVar(index).Value() == 1 for index in job_indices):
                routing.solver().FinishCurrentSearch()

        routing.AddAtSolutionCallback(stop_after_first_full_solution)
    assignment = routing.SolveWithParameters(parameters)
    if assignment is None:
        return MasterSolution(
            status=MasterSolveStatus.NO_SOLUTION_WITHIN_LIMIT,
            planning_at=master.planning_at,
            routes=(),
            unserved_job_ids=(),
            objective_proofs=(),
            dataset_sha256=dataset.dataset_sha256,
            screening_snapshot_sha256=master.screening_snapshot_sha256,
            solver_version=version('ortools'),
            search_graph_complete=True,
            searched_arc_count=len(master.arcs),
            operationally_excluded_arcs=tuple(
                ('*', origin, destination)
                for origin, destination in forbidden_job_arcs
            ),
        )

    routes: list[MasterEngineerRoute] = []
    assigned_jobs: set[str] = set()
    for vehicle, engineer_id in enumerate(engineer_ids):
        index = routing.Start(vehicle)
        origin_node_id = f'START:{engineer_id}'
        visits: list[MasterVisit] = []
        while not routing.IsEnd(index):
            next_index = assignment.Value(routing.NextVar(index))
            next_node = manager.IndexToNode(next_index)
            if next_node in node_job:
                job_id = node_job[next_node]
                service_minute = assignment.Value(time_dimension.CumulVar(next_index))
                from_node = manager.IndexToNode(index)
                origin_location = location_id(from_node)
                destination_location = dataset.jobs[job_id].location_id
                engineer = dataset.engineers[engineer_id]
                estimate = screening.estimate(
                    engineer.zone_id,
                    engineer.transport_mode,
                    origin_location,
                    destination_location,
                )
                departure_minute = service_minute - estimate.duration_minutes
                visits.append(MasterVisit(
                    sequence=len(visits) + 1,
                    job_id=job_id,
                    origin_node_id=origin_node_id,
                    departure_at=day_start + timedelta(minutes=departure_minute),
                    service_start_at=day_start + timedelta(minutes=service_minute),
                    screening_duration_minutes=estimate.duration_minutes,
                    screening_distance_m=estimate.distance_m,
                    screening_source_mode=estimate.source_mode.value,
                    screening_is_surrogate=estimate.is_surrogate,
                ))
                assigned_jobs.add(job_id)
                origin_node_id = job_id
            index = next_index
        if visits:
            routes.append(MasterEngineerRoute(engineer_id, tuple(visits)))
    unserved_job_ids = tuple(sorted(set(active_job_ids) - assigned_jobs))
    return MasterSolution(
        status=MasterSolveStatus.SCREENING_FEASIBLE,
        planning_at=master.planning_at,
        routes=tuple(routes),
        unserved_job_ids=unserved_job_ids,
        objective_proofs=(),
        dataset_sha256=dataset.dataset_sha256,
        screening_snapshot_sha256=master.screening_snapshot_sha256,
        solver_version=version('ortools'),
        search_graph_complete=True,
        searched_arc_count=len(master.arcs),
        operationally_excluded_arcs=tuple(
            ('*', origin, destination)
            for origin, destination in forbidden_job_arcs
        ),
    )
