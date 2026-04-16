# @dofek/scoring

Domain logic for health scores, training metrics, and design tokens. Shared between web and mobile.

## Implementation Details

### Scoring Models

- **Strain Score (`scoring.ts`)**: Implements a Whoop-like 0–21 scale. `StrainScore.fromRawLoad` uses logarithmic scaling (`3.5 * Math.log(1 + rawLoad)`) to represent diminishing returns of high-intensity efforts.
- **Recovery & Readiness**:
  - `zScoreToRecoveryScore` converts z-scores to a 0–100 scale using an asymmetric sigmoid centered at 62.
  - `computeStrainTarget` recommends a daily target (Push/Maintain/Recovery) based on readiness and ACWR (Acute:Chronic Workload Ratio). Targets are capped if ACWR > 1.3 to prevent injury.
- **Sleep Performance (`sleep-performance.ts`)**: Calculated as 70% sleep sufficiency (actual vs needed) and 30% sleep efficiency.
- **Healthspan Years (`healthspan-years.ts`)**: Maps a 0–100 health score to a biological age delta (+3 to -2 years). The model is intentionally asymmetric, penalizing poor health more than rewarding peak fitness.
- **Menstrual Cycle (`menstrual-cycle.ts`)**: Categorizes days into Menstrual, Follicular, Ovulatory, and Luteal phases using an estimated ovulation day of `cycleLength - 14`.

### Design System & Tokens (`tokens.ts`, `colors.ts`)

- **Semantic Colors**: Defines `statusColors` (positive, warning, danger) and platform-agnostic `chartColors`.
- **Typography**: Standardized font families ("Inter" for body, "DM Mono" for metrics) and font sizes.
- **Animation**: Shared durations for micro-interactions (`fast: 150ms`) and chart animations (`chart: 1200ms`).
- **Spacing**: Consistent scales for layout (`xs: 4px` to `xl: 32px`) and border radii.

### Breathwork (`breathwork.ts`)
Defines standard techniques (Box Breathing, 4-7-8, Coherent, Physiological Sigh, Wim Hof) with specific inhale/hold/exhale/hold durations.
