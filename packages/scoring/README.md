# @dofek/scoring

Platform-agnostic TypeScript presentation helpers and shared design tokens,
used by both web and mobile clients without a UI-framework dependency
([package exports](package.json)).

## Install

```sh
npm install @dofek/scoring
```

Requires Node.js 22.14 or newer.

## Usage

There is no root export; import the subpath for the model you need.

```ts
import { statusColors } from "@dofek/scoring/colors";

console.log(statusColors.positive);
```

## Public API

| Subpath | Purpose |
| --- | --- |
| `@dofek/scoring/scoring` | Trend, score-zone, and presentation helpers |
| `@dofek/scoring/colors` | Semantic, chart, surface, text, sleep-stage, and activity colors |
| `@dofek/scoring/tokens` | Framework-neutral typography, spacing, radius, animation, and chart tokens |
| `@dofek/scoring/epistemic-status` | Shared Observed / Estimated / Associated / Suggested / Unavailable status vocabulary |
| `@dofek/scoring/healthspan-years` | Score-to-years mapping and formatting |
| `@dofek/scoring/loading-policy` | Blocking-loading state policy |
| `@dofek/scoring/query-cache` | Shared query-cache age constant |

## Model behavior

- Healthspan display deltas map scores from 0–100 onto +3 to -2 years.
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
