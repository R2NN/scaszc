from __future__ import annotations

import unittest

from beeline_planning import ScreeningSolutionQuality


def quality(
    urgent: int,
    normal: int,
    teams: int,
    response: int = 0,
    distance: int = 0,
) -> ScreeningSolutionQuality:
    return ScreeningSolutionQuality(
        urgent,
        normal,
        teams,
        response,
        distance,
        0,
        0,
        0,
        (),
    )


class ScreeningSolutionQualityTests(unittest.TestCase):
    def test_coverage_always_beats_using_fewer_teams(self) -> None:
        full_coverage = quality(0, 0, 12, response=1000)
        fewer_teams_but_one_unserved = quality(0, 1, 1)
        self.assertLess(full_coverage.key, fewer_teams_but_one_unserved.key)

    def test_fewer_teams_wins_when_coverage_is_equal(self) -> None:
        five_teams = quality(0, 1, 5, response=1000, distance=100_000)
        six_teams = quality(0, 1, 6, response=0, distance=0)
        self.assertLess(five_teams.key, six_teams.key)

    def test_other_metrics_apply_only_after_coverage_and_teams(self) -> None:
        faster = quality(0, 1, 5, response=100, distance=50_000)
        slower = quality(0, 1, 5, response=101, distance=1)
        self.assertLess(faster.key, slower.key)


if __name__ == '__main__':
    unittest.main()
