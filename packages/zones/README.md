# @dofek/zones

Framework-neutral heart-rate and cycling-power zone definitions, classification,
range formatting, time-distribution mapping, and polarization analysis.

## Install

```sh
npm install @dofek/zones
```

Requires Node.js 22.14 or newer.

## Usage

```ts
import {
  classifyHeartRateZone,
  computePolarizationIndex,
  heartRateZoneBoundaries,
} from "@dofek/zones";

const maxHeartRate = 190;
const restingHeartRate = 55;

console.log(heartRateZoneBoundaries(maxHeartRate, restingHeartRate));
console.log(classifyHeartRateZone(150, maxHeartRate, restingHeartRate));
console.log(computePolarizationIndex(3_600, 300, 600));
```

## Public API

Both `@dofek/zones` and `@dofek/zones/zones` expose the same API:

- Heart-rate definitions, colors, boundaries, classification, range labels, and
  complete time-in-zone rows.
- Cycling-power definitions, colors, FTP-relative boundaries, classification,
  range labels, and complete time-in-zone rows.
- Generic zone-distribution row and label helpers.
- Three-zone polarization definitions and `computePolarizationIndex`.
- TypeScript interfaces for all definitions, boundaries, rows, and activity
  zones.

## Models and behavior

### Heart-rate reserve

The five activity zones use heart-rate reserve:

```text
HRR fraction = (heart rate - resting heart rate) / (maximum heart rate - resting heart rate)
```

The boundaries are 50–60%, 60–70%, 70–80%, 80–90%, and 90–100% HRR.
This model is based on the heart-rate-reserve approach described by
[Karvonen, Kentala, and Mustala (1957)](https://pubmed.ncbi.nlm.nih.gov/13470504/).
Readings below the first boundary classify as zone 0.

### Polarization index

`computePolarizationIndex` implements:

```text
PI = log10((f1 / f2) × f3 × 100)
```

where each `f` is the fraction of total time in one of the three intensity
zones. The function returns `null` when any zone has no time, which is Dofek's
explicit calculation choice, or when Zone 3 exceeds Zone 1, which Treff defines
as outside the index's valid range. The formula and descriptive 2.0 heuristic come from
[Treff et al. (2019)](https://www.frontiersin.org/journals/physiology/articles/10.3389/fphys.2019.00707/full).
The index describes a recorded training-intensity distribution; it is not a
physiological or medical assessment.

### Cycling power

The package defines seven FTP-relative cycling-power zones and exposes helpers
to convert them into watt boundaries or classify individual power readings.

The package performs no network requests and needs no authentication or runtime
configuration. Callers are responsible for supplying valid, individualized
maximum/resting heart rates and FTP values. The calculations are training
analysis tools, not medical advice.

## License and contributing

[MIT](./LICENSE). Source is in the
[Dofek repository](https://github.com/Asherlc/dofek/tree/main/packages/zones).
Please [open an issue](https://github.com/Asherlc/dofek/issues) for bugs or API
proposals, or [submit a pull request](https://github.com/Asherlc/dofek/pulls).
