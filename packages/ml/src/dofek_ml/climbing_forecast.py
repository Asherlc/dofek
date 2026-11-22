"""Chronological holdout inputs for the assigned-grade Bradley–Terry model."""

from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import mean, quantiles
from typing import TYPE_CHECKING, TypedDict

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence
    from datetime import date


@dataclass(frozen=True)
class ClimbDay:
    """One owner's observed outcome for an identified climb in one model context."""

    climb: str
    day: date
    grade: float
    sent: bool
    grade_known_on: date | None


@dataclass(frozen=True)
class Holdout:
    training: tuple[ClimbDay, ...]
    familiar: tuple[ClimbDay, ...]
    unfamiliar: tuple[ClimbDay, ...]
    unavailable: tuple[ClimbDay, ...]


def split_holdout(
    days: Iterable[ClimbDay], cutoff: date, *, retrospective: bool = False
) -> Holdout:
    """Hold out complete calendar days, with grades available before the cutoff."""

    def grade_available(observation: ClimbDay) -> bool:
        known_on = observation.grade_known_on
        return retrospective if known_on is None else known_on < cutoff

    history = []
    candidates = []
    for observation in days:
        if observation.day < cutoff:
            history.append(observation)
        else:
            candidates.append(observation)

    previously_tried = {observation.climb for observation in history}
    available = [observation for observation in candidates if grade_available(observation)]
    return Holdout(
        training=tuple(observation for observation in history if grade_available(observation)),
        familiar=tuple(
            observation for observation in available if observation.climb in previously_tried
        ),
        unfamiliar=tuple(
            observation for observation in available if observation.climb not in previously_tried
        ),
        unavailable=tuple(
            observation for observation in candidates if not grade_available(observation)
        ),
    )


def send_probability(climber_grade: float, climb_grade: float, slope: float) -> float:
    """Drummond and Popinga's assigned-grade likelihood, evaluated in log odds."""
    log_odds = slope * (climber_grade - climb_grade)
    exponential = math.exp(-abs(log_odds))
    return 1.0 / (1.0 + exponential) if log_odds >= 0 else exponential / (1.0 + exponential)


@dataclass(frozen=True)
class ProbabilityScores:
    count: int
    observed_send_rate: float
    mean_probability: float
    brier: float
    log_loss: float


def _probability_scores(
    outcomes: Sequence[bool], probabilities: Sequence[float], losses: Sequence[float]
) -> ProbabilityScores:
    """Assemble one score summary from per-observation log losses."""
    count = len(outcomes)
    return ProbabilityScores(
        count=count,
        observed_send_rate=sum(outcomes) / count,
        mean_probability=sum(probabilities) / count,
        brier=sum(
            (prediction - sent) ** 2
            for sent, prediction in zip(outcomes, probabilities, strict=True)
        )
        / count,
        log_loss=sum(losses) / count,
    )


def score_probabilities(
    outcomes: Sequence[bool], probabilities: Sequence[float]
) -> ProbabilityScores | None:
    if len(outcomes) != len(probabilities):
        raise ValueError("Each held-out outcome requires one probability")
    if not outcomes:
        return None
    if any(not 0 < prediction < 1 for prediction in probabilities):
        raise ValueError("Log-loss evaluation requires probabilities strictly between zero and one")
    losses = [
        -math.log(prediction) if sent else -math.log1p(-prediction)
        for sent, prediction in zip(outcomes, probabilities, strict=True)
    ]
    return _probability_scores(outcomes, probabilities, losses)


class ModelData(TypedDict):
    month_count: int
    observation_count: int
    observation_month: list[int]
    climb_grade: list[float]
    sent: list[int]
    initial_grade: float


def _month_index(start: date, end: date) -> int:
    return 12 * (end.year - start.year) + end.month - start.month + 1


def build_model_data(
    training: Sequence[ClimbDay], through: date, *, initial_grade: float
) -> ModelData:
    """Include future monthly states without passing held-out grades or labels to Stan."""
    if {observation.sent for observation in training} != {True, False}:
        raise ValueError("Training requires both sends and unsuccessful days")
    if any(observation.day > through for observation in training):
        raise ValueError("Training days cannot fall after the model window")
    first = min(observation.day for observation in training)
    return ModelData(
        month_count=_month_index(first, through),
        observation_count=len(training),
        observation_month=[_month_index(first, observation.day) for observation in training],
        climb_grade=[observation.grade for observation in training],
        sent=[int(observation.sent) for observation in training],
        initial_grade=initial_grade,
    )


@dataclass(frozen=True)
class CohortScores:
    model: ProbabilityScores | None
    baseline: ProbabilityScores | None
    mean_probability_interval: tuple[float, float] | None


@dataclass(frozen=True)
class HoldoutScores:
    familiar: CohortScores
    unfamiliar: CohortScores
    unavailable_count: int


def _observed_log_probability(log_odds: float, sent: bool) -> float:
    """Stable log P(observed outcome) via the logistic/softplus identity."""
    signed = log_odds if sent else -log_odds
    return min(signed, 0.0) - math.log1p(math.exp(-abs(signed)))


def _log_mean_exp(values: Sequence[float]) -> float:
    """Compute the log of the mean exponential with a max shift."""
    largest = max(values)
    return largest + math.log(mean(math.exp(value - largest) for value in values))


def score_holdout(
    split: Holdout, *, slopes: Sequence[float], abilities: Sequence[Sequence[float]]
) -> HoldoutScores:
    """Compare posterior means with the earlier send rate on the same held-out days."""
    if {observation.sent for observation in split.training} != {True, False}:
        raise ValueError("Training requires both sends and unsuccessful days")
    if len(slopes) < 2:
        raise ValueError("At least two posterior draws are required")
    draws = list(zip(slopes, abilities, strict=True))
    first = min(observation.day for observation in split.training)
    baseline = mean(observation.sent for observation in split.training)

    def score_cohort(cohort: Sequence[ClimbDay]) -> CohortScores:
        if not cohort:
            return CohortScores(None, None, None)
        probabilities = [
            [
                send_probability(ability[_month_index(first, row.day) - 1], row.grade, slope)
                for slope, ability in draws
            ]
            for row in cohort
        ]
        outcomes = [row.sent for row in cohort]
        # Summarize uncertainty in the cohort's mean forecast across posterior draws.
        intervals = quantiles(
            (mean(draw) for draw in zip(*probabilities, strict=True)), n=20, method="inclusive"
        )
        # Compute posterior predictive loss in log space to handle saturated draws.
        losses = []
        for row in cohort:
            index = _month_index(first, row.day) - 1
            losses.append(
                -_log_mean_exp(
                    [
                        _observed_log_probability(slope * (ability[index] - row.grade), row.sent)
                        for slope, ability in draws
                    ]
                )
            )
        return CohortScores(
            _probability_scores(outcomes, [mean(target) for target in probabilities], losses),
            score_probabilities(outcomes, [baseline] * len(outcomes)),
            (intervals[0], intervals[-1]),
        )

    return HoldoutScores(
        familiar=score_cohort(split.familiar),
        unfamiliar=score_cohort(split.unfamiliar),
        unavailable_count=len(split.unavailable),
    )
