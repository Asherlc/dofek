# @dofek/scoring

Platform-agnostic TypeScript models for health scores, sleep and readiness
presentation, breathwork sessions, and shared design tokens. The package is used
by both web and mobile clients but has no UI-framework dependency.

## Install

```sh
npm install @dofek/scoring
```

Requires Node.js 22.14 or newer.

## Usage

There is no root export; import the subpath for the model you need.

```ts
import {
  StrainScore,
  zScoreToRecoveryScore,
} from "@dofek/scoring/scoring";

const strain = StrainScore.fromRawLoad(120);

console.log({
  strain: strain.value,
  strainLabel: strain.label,
  recovery: zScoreToRecoveryScore(0.75),
});
```

## Public API

| Subpath | Purpose |
| --- | --- |
| `@dofek/scoring/scoring` | Strain, recovery, workload-ratio, trend, score-zone, and presentation helpers |
| `@dofek/scoring/colors` | Semantic, chart, surface, text, sleep-stage, and activity colors |
| `@dofek/scoring/tokens` | Framework-neutral typography, spacing, radius, animation, and chart tokens |
| `@dofek/scoring/strain-target` | Daily strain-target calculation and result types |
| `@dofek/scoring/today-plan` | Deterministic Today Plan action, supporting facts, and confidence rules |
| `@dofek/scoring/sleep-performance` | Sleep-performance components, tiers, and recommended-bedtime calculation |
| `@dofek/scoring/healthspan-years` | Score-to-years mapping and formatting |
| `@dofek/scoring/menstrual-cycle` | Cycle-phase estimation and display metadata |
| `@dofek/scoring/breathwork` | Built-in breathing techniques and session-duration helpers |
| `@dofek/scoring/loading-policy` | Blocking-loading state policy |
| `@dofek/scoring/query-cache` | Shared query-cache age constant |

## Model behavior

- `StrainScore.fromRawLoad` applies logarithmic scaling, maps non-positive loads
  to zero, and caps the result at 21.
- `zScoreToRecoveryScore` uses a Dofek-defined asymmetric sigmoid where a
  z-score of zero maps to 62.
- Strain targets use Dofek-defined readiness bands and cap the target when the
  acute-to-chronic workload ratio exceeds 1.3.
- Sleep performance defaults to 70% sleep sufficiency and 30% efficiency. When
  consistency or low-stress inputs are supplied, it averages all available
  components equally.
- Healthspan display deltas map scores from 0–100 onto +3 to -2 years.
- Cycle phases estimate ovulation as `cycleLength - 14`; this is a display
  estimate, not a clinical assessment.
- The design-token modules contain values only; they do not install fonts or
  render UI.

The package performs no network requests and needs no authentication or runtime
configuration. Validate untrusted input before calling the calculation
functions. These models are for fitness software and are not medical advice.

## License and contributing

[MIT](./LICENSE). Source is in the
[Dofek repository](https://github.com/Asherlc/dofek/tree/main/packages/scoring).
Please [open an issue](https://github.com/Asherlc/dofek/issues) for bugs or API
proposals, or [submit a pull request](https://github.com/Asherlc/dofek/pulls).
