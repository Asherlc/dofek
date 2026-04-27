# @dofek/heart-rate-variability

Logic for analyzing and selecting Heart Rate Variability (HRV) metrics.

## Overview

Heart Rate Variability data, particularly from Apple Health, can be noisy. This package provides logic to extract a representative daily HRV value for Apple Health.

## Selection Strategy

- **Averaging Strategy**: Apple Health HRV can include multiple samples in a day, including elevated values from Breathe or mindfulness sessions. This package averages all samples for the day to produce a more stable baseline.
- **Representative Baseline**: Averaging helps avoid overfitting to a single noisy sample and better reflects trend over the day.
- **Apple Watch Specifics**: Apple Watch records SDNN during both sleep and Breathe/Mindfulness sessions. Using the average includes all captured readings for that day.

## Key Functions

- `selectDailyHeartRateVariability(samples)`: Given an array of HRV samples for a day (containing `value` and `startDate`), returns the arithmetic mean of all sample values.

## Implementation Details

The implementation validates `startDate` values as `Date` objects or ISO 8601 strings, but the current averaging logic intentionally ignores ordering and uses only sample values.
