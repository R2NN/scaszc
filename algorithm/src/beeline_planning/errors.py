"""Planning errors; invalid data is never repaired with implicit defaults."""


class PlanningError(Exception):
    """Base class for workforce-planning failures."""


class InvalidPlanningData(PlanningError):
    """The input dataset violates the mathematical model contract."""


class InvalidPlan(PlanningError):
    """A proposed plan violates one or more hard constraints."""


class HardModelInfeasible(PlanningError):
    """Frozen state or a hard commitment makes the model contradictory."""
