# @dofek/heart-rate-variability

Logic for analyzing and selecting Heart Rate Variability (HRV) metrics.

## Overview

Heart Rate Variability data, particularly from Apple Health, can be noisy. This package provides logic to extract the most representative HRV value for a given day (the "overnight baseline").

## Selection Strategy

- **Earliest Sample Wins**: To avoid "inflated" HRV readings from daytime breathing or mindfulness sessions (which can be 2x higher than resting levels), this package prioritizes the earliest recorded sample of the day.
- **Overnight Focus**: The earliest reading typically occurs during sleep or immediately upon waking, reflecting the true autonomic status.
- **Apple Watch Specifics**: Apple Watch records SDNN during both sleep and Breathe/Mindfulness sessions. By picking the earliest chronological sample, we filter out the maximal parasympathetic tone induced by deliberate slow breathing.

## Key Functions

- `selectDailyHeartRateVariability(samples)`: Given an array of HRV samples for a day (containing `value` and `startDate`), returns the value of the earliest sample.

## Implementation Details

The implementation uses `Date.parse()` or `.getTime()` to compare `startDate` values and find the minimum (earliest) timestamp. It handles both `Date` objects and ISO 8601 string dates.
