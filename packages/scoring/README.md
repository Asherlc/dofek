# @dofek/scoring

Platform-agnostic TypeScript models for health scores, sleep and readiness
presentation, and shared design tokens. The package is used
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
| `@dofek/scoring/scoring` | Strain, recovery, trend, score-zone, and presentation helpers |
| `@dofek/scoring/colors` | Semantic, chart, surface, text, sleep-stage, and activity colors |
| `@dofek/scoring/tokens` | Framework-neutral typography, spacing, radius, animation, and chart tokens |
| `@dofek/scoring/strain-target` | Daily strain-target calculation and result types |
| `@dofek/scoring/today-plan` | Deterministic ready/insufficient-data Today Plan result with a primary action, supporting facts, server-authored caveats, confidence, freshness, and shared presentation helpers |
| `@dofek/scoring/epistemic-status` | Shared Observed / Estimated / Associated / Suggested / Unavailable status vocabulary |
| `@dofek/scoring/sleep-performance` | Sleep-performance components, tiers, and recommended-bedtime calculation |
| `@dofek/scoring/healthspan-years` | Score-to-years mapping and formatting |
| `@dofek/scoring/menstrual-cycle` | Cycle-phase estimation, display metadata, and shared safety copy |
| `@dofek/scoring/loading-policy` | Blocking-loading state policy |
| `@dofek/scoring/query-cache` | Shared query-cache age constant |

## Model behavior

- `StrainScore.fromRawLoad` applies logarithmic scaling, maps non-positive loads
  to zero, and caps the result at 21.
- `zScoreToRecoveryScore` uses a Dofek-defined asymmetric sigmoid where a
  z-score of zero maps to 62.
- Strain targets use Dofek-defined readiness bands.
- Today Plan keeps Push and Recovery recommendations actionable while presenting
  the Maintain band as the neutral “No change needs attention” state
  ([rule builder](./src/today-plan.ts), [executable tests](./src/today-plan.test.ts)).
- Ready Today Plan results include server-authored supporting observations and
  caveats for missing or stale inputs; clients render these values without
  deriving their meaning.
- Sleep performance defaults to 70% sleep sufficiency and 30% efficiency. When
  consistency or low-stress inputs are supplied, it averages all available
  components equally.
- Healthspan display deltas map scores from 0–100 onto +3 to -2 years.
- Cycle phases estimate ovulation as `cycleLength - 14`; this is a display
  estimate, not a clinical assessment. A primary evaluation found that
  cycle-length-only calendar methods cannot accurately predict ovulation day
  ([Johnson et al., 2018](https://pubmed.ncbi.nlm.nih.gov/29749274/)). The
  shared safety notice follows
  [Apple's Cycle Tracking limitation](https://support.apple.com/en-au/120356)
  that these estimates must not be used for birth control or diagnosis.
- The design-token modules contain values only; they do not install fonts or
  render UI.
- `operationalStatusColors` is the light-theme presentation palette for generic
  application states. Its foregrounds meet the
  [WCAG 2.2 normal-text contrast requirement](https://www.w3.org/TR/WCAG22/#contrast-minimum)
  on paired surfaces, and its borders/indicators meet
  [WCAG 2.2 non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast).
  It does not classify health, nutrition, training, clinical, or scoring values;
  those domain meanings remain with their owning models.

The package performs no network requests and needs no authentication or runtime
configuration. Validate untrusted input before calling the calculation
functions. These models are for fitness software and are not medical advice.

## License and contributing

[MIT](./LICENSE). Source is in the
[Dofek repository](https://github.com/Asherlc/dofek/tree/main/packages/scoring).
Please [open an issue](https://github.com/Asherlc/dofek/issues) for bugs or API
proposals, or [submit a pull request](https://github.com/Asherlc/dofek/pulls).
