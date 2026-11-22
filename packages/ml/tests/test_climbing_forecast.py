import math
from datetime import date

import pytest

from dofek_ml.climbing_forecast import (
    ClimbDay,
    Holdout,
    build_model_data,
    score_holdout,
    score_probabilities,
    send_probability,
    split_holdout,
)


def _observation(climb: str, day: int, *, grade_known_day: int | None = 1) -> ClimbDay:
    return ClimbDay(
        climb=climb,
        day=date(2026, 9, day),
        grade=20,
        sent=True,
        grade_known_on=date(2026, 9, grade_known_day) if grade_known_day is not None else None,
    )


def test_holdout_starts_at_cutoff_and_uses_only_earlier_grade_evidence() -> None:
    previous = _observation("familiar", 5)
    familiar = _observation("familiar", 10)
    first_recorded = _observation("unfamiliar", 10)
    known_too_late = _observation("new-grade", 10, grade_known_day=10)
    no_grade_date = _observation("mutable-grade", 11, grade_known_day=None)

    split = split_holdout(
        [previous, familiar, first_recorded, known_too_late, no_grade_date], date(2026, 9, 10)
    )

    assert split.training == (previous,)
    assert split.familiar == (familiar,)
    assert split.unfamiliar == (first_recorded,)
    assert split.unavailable == (known_too_late, no_grade_date)


def test_assigned_grade_likelihood_has_even_odds_at_equal_grades() -> None:
    assert send_probability(20.0, 20.0, 0.5) == 0.5
    assert send_probability(20.0, 22.0, 0.5) == pytest.approx(0.2689414214)


def test_retrospective_mode_accepts_undated_grades_but_respects_explicit_dates() -> None:
    undated = _observation("frozen", 10, grade_known_day=None)
    too_late = _observation("changed", 11, grade_known_day=10)
    split = split_holdout([undated, too_late], date(2026, 9, 10), retrospective=True)

    assert split.unfamiliar == (undated,)
    assert split.unavailable == (too_late,)


def test_reports_probability_scores_and_calibration_in_the_large() -> None:
    scores = score_probabilities([True, False], [0.8, 0.3])

    assert scores is not None
    assert scores.count == 2
    assert scores.observed_send_rate == 0.5
    assert scores.mean_probability == pytest.approx(0.55)
    assert scores.brier == pytest.approx(0.065)
    assert scores.log_loss == pytest.approx(0.2899092476)
    assert score_probabilities([], []) is None


def test_model_data_uses_monthly_states_and_keeps_heldout_outcomes_out() -> None:
    history = (
        ClimbDay("a", date(2026, 6, 10), 21.0, True, date(2026, 6, 1)),
        ClimbDay("b", date(2026, 8, 3), 22.0, False, date(2026, 6, 1)),
    )

    assert build_model_data(history, date(2026, 9, 5), initial_grade=18.0) == {
        "month_count": 4,
        "observation_count": 2,
        "observation_month": [1, 3],
        "climb_grade": [21.0, 22.0],
        "sent": [1, 0],
        "initial_grade": 18.0,
    }


def test_model_data_requires_sent_and_unsent_observations() -> None:
    with pytest.raises(ValueError, match="sends and unsuccessful days"):
        build_model_data((_observation("a", 2),), date(2026, 9, 5), initial_grade=18.0)


def test_scores_familiar_and_unfamiliar_climbs_on_the_same_baseline() -> None:
    cutoff = date(2026, 9, 10)
    split = split_holdout(
        [
            _observation("familiar", 5),
            ClimbDay("prior-failure", date(2026, 9, 5), 20, False, date(2026, 9, 1)),
            _observation("familiar", 10),
            _observation("unfamiliar", 11),
            _observation("unavailable", 12, grade_known_day=None),
        ],
        cutoff,
    )

    report = score_holdout(split, slopes=[1.0, 1.0], abilities=[[20.0], [20.0]])

    assert report.familiar.model is not None
    assert report.familiar.model.brier == 0.25
    assert report.familiar.baseline == report.familiar.model
    assert report.unfamiliar.model == report.familiar.model
    assert report.unfamiliar.mean_probability_interval == (0.5, 0.5)
    assert report.unavailable_count == 1


def _saturated_split() -> Holdout:
    """A familiar observed failure and an unfamiliar observed send, both vs log odds +40."""
    return split_holdout(
        [
            ClimbDay("prior-send", date(2026, 9, 5), 20, True, date(2026, 9, 1)),
            ClimbDay("prior-fail", date(2026, 9, 5), 20, False, date(2026, 9, 1)),
            ClimbDay("prior-send", date(2026, 9, 10), 20, False, date(2026, 9, 1)),
            ClimbDay("new-send", date(2026, 9, 10), 20, True, date(2026, 9, 1)),
        ],
        date(2026, 9, 10),
    )


def test_posterior_predictive_loss_is_finite_for_saturated_predictions() -> None:
    report = score_holdout(_saturated_split(), slopes=[1.0, 1.0], abilities=[[60.0], [60.0]])
    familiar = report.familiar.model
    unfamiliar = report.unfamiliar.model
    assert familiar is not None
    assert unfamiliar is not None

    # An observed failure against log odds +40 stays finite at ~40 with Brier 1.
    assert math.isfinite(familiar.log_loss)
    assert familiar.log_loss == pytest.approx(40.0, abs=1e-6)
    assert familiar.brier == pytest.approx(1.0)

    # An observed send against log odds +40 has tiny finite loss with Brier 0.
    assert math.isfinite(unfamiliar.log_loss)
    assert 0.0 < unfamiliar.log_loss < 1e-12
    assert unfamiliar.brier == pytest.approx(0.0)

    # Intervals and the unchanged training baseline are retained.
    assert report.familiar.mean_probability_interval == (1.0, 1.0)
    assert report.unfamiliar.mean_probability_interval == (1.0, 1.0)
    assert report.familiar.baseline is not None
    assert report.unfamiliar.baseline is not None
    assert report.familiar.baseline.mean_probability == pytest.approx(0.5)
    assert report.familiar.baseline.log_loss == pytest.approx(math.log(2))
    assert report.unfamiliar.baseline.mean_probability == pytest.approx(0.5)
    assert report.unfamiliar.baseline.log_loss == pytest.approx(math.log(2))


def test_posterior_predictive_loss_averages_probabilities_not_per_draw_losses() -> None:
    report = score_holdout(_saturated_split(), slopes=[1.0, 1.0], abilities=[[60.0], [-20.0]])
    unfamiliar = report.unfamiliar.model
    assert unfamiliar is not None

    # The two draws average to an outcome probability of 0.5, yielding log(2).
    assert unfamiliar.mean_probability == pytest.approx(0.5)
    assert unfamiliar.brier == pytest.approx(0.25)
    assert unfamiliar.log_loss == pytest.approx(math.log(2), abs=1e-6)


def test_direct_score_probabilities_still_rejects_saturated_probabilities() -> None:
    with pytest.raises(ValueError, match="strictly between zero and one"):
        score_probabilities([True], [1.0])
