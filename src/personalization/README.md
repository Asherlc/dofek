# Personalization

This directory contains the core algorithms and fitting logic used to personalize the Dofek experience for each user based on their historical data.

## Core Features

- **Training Load Modeling**: Fits EWMA windows (Chronic/Acute Training Load) to individual physiological response using `fitExponentialMovingAverage`.
- **Recovery Scoring**: Learns optimal readiness weights for HRV, RHR, and sleep to predict next-day HRV z-scores via `fitReadinessWeights`.
- **Targeting**: Determines personalized sleep duration targets and stress z-score thresholds.
- **TRIMP Calibration**: Calibrates Training Impulse (TRIMP) constants by benchmarking against power-based TSS data.
- **Refitting Engine**: Orchestrates the full re-fitting of all parameters using a user's historical data from the database (`refit.ts`).

## Implementation Details

- **Analytical SQL**: Uses complex analytical queries (window functions, `generate_series`, `PERCENTILE_CONT`) to extract fitting data efficiently.
- **Grid Search**: Employs grid search over physiological candidates to find optimal parameters (e.g., CTL/ATL windows).
- **Z-Score Normalization**: Leverages z-scores for inter-metric comparison and normalized scoring.
- **User Settings**: Personalized parameters are stored as a JSON object in the `user_settings` table.

## Key Files

- `refit.ts`: High-level entry point for refitting user parameters.
- `fit-ewma.ts`: Training load (CTL/ATL) modeling.
- `fit-readiness-weights.ts`: Recovery/Readiness weight fitting.
- `fit-trimp.ts`: TRIMP constant calibration.
- `fit-sleep-target.ts`: Personalized sleep goal calculation.
- `params.ts`: Type definitions for personalized parameters.
- `storage.ts`: Logic for saving and loading parameters from the database.
