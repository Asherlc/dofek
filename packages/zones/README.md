# @dofek/zones

Heart rate zone models and physiological analysis utilities.

## Features

- **Karvonen 5-Zone Model**: Activity intensity zones based on Heart Rate Reserve (%HRR).
- **Treff 3-Zone Model**: Polarization analysis zones based on Maximum Heart Rate (%HRmax).
- **Polarization Index**: Metric to quantify training distribution (polarized vs non-polarized).
- **Classification**: Tools for classifying heart rate readings and mapping time-in-zone distributions.

## Implementation Details

### Heart Rate Reserve (Karvonen)
Zones are defined in `HEART_RATE_ZONES` using `%HRR = (heartRate - restingHr) / (maxHr - restingHr)`.
1. **Recovery** (50-60%)
2. **Aerobic** (60-70%)
3. **Tempo** (70-80%)
4. **Threshold** (80-90%)
5. **VO2max** (90-100%)

### Polarization Index
The `computePolarizationIndex` function uses the Treff 3-zone model (Easy < 80% HRmax, Threshold 80-90%, High > 90%) to compute:
`PI = log10((f1 / (f2 * f3)) * 100)`
A PI > 2.0 indicates a well-polarized training distribution.
