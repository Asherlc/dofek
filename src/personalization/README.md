# Personalization

This directory contains the core algorithms and fitting logic used to personalize the Dofek experience for each user based on their historical data.

## Core Features

- **Training Load Modeling**: Fits EWMA windows (Chronic/Acute Training Load) to individual physiological response using `fitExponentialMovingAverage`.
- **Recovery Scoring**: Learns optimal readiness weights for HRV, RHR, and sleep to predict next-day HRV z-scores via `fitReadinessWeights`.
- **Targeting**: Determines personalized sleep duration targets and stress z-score thresholds.
- **TRIMP Calibration**: Calibrates Training Impulse (TRIMP) constants by benchmarking against power-based TSS data.
- **Refitting Engine**: Orchestrates the full re-fitting of all parameters using a user's historical data from the database (`refit.ts`).
- **Model Cards**: Builds the same evidence for web and mobile, including the source window, minimum data requirements, fit statistic, excluded-data rules, default state, and last successful fit time ([model-card.ts](./model-card.ts)).

## Implementation Details

- **Analytical SQL**: Uses complex analytical queries (window functions, `generate_series`, `PERCENTILE_CONT`) to extract fitting data efficiently.
- **Grid Search**: Employs grid search over physiological candidates to find optimal parameters (e.g., CTL/ATL windows).
- **Z-Score Normalization**: Leverages z-scores for inter-metric comparison and normalized scoring.
- **User Settings**: Personalized parameters and optional per-model successful-fit timestamps are stored together in the canonical JSON object in `user_settings` ([params.ts](./params.ts), [storage.ts](./storage.ts)).
- **Fit timestamps**: `fittedAt` records the latest refit attempt. `successfulFitAt` records a model timestamp only when that model returns a newly accepted fit; older learned models report an unavailable successful-fit time until the next accepted refit ([refit.ts](./refit.ts)).
- **Evidence limits**: Current fitters expose sample counts plus Pearson correlation or R² where calculated. They do not calculate calibrated uncertainty intervals or retained excluded-row counts, so model cards say those values are unavailable instead of deriving confidence proxies ([model-card.ts](./model-card.ts)).

## Key Files

- `refit.ts`: High-level entry point for refitting user parameters.
- `fit-ewma.ts`: Training load (CTL/ATL) modeling.
- `fit-readiness-weights.ts`: Recovery/Readiness weight fitting.
- `fit-trimp.ts`: TRIMP constant calibration.
- `fit-sleep-target.ts`: Personalized sleep goal calculation.
- `model-card.ts`: Server-owned model evidence and transparency text.
- `params.ts`: Type definitions for personalized parameters.
- `storage.ts`: Logic for saving and loading parameters from the database.
