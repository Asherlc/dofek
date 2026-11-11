# Climbing visualization options

The climbing strengths section offers six visualization directions as selectable views, alongside its existing grade profile. The user chose multiple visualization options after reviewing the mockups.

## Behavior

- One compact **View** picker on web and mobile offers **Grade profile**, **Style gaps**, **Success curves**, **Exposure map**, **Grade pyramids**, **Progress**, and **Radar profile**. Grade profile preserves the existing platform presentation and remains the default.
- Changing views preserves the current context, indoor/outdoor setting, selected grade, and selected style/source-climb detail when its keys remain valid. View choice is local component state; no new stored preference is required.
- Context, grade systems, and settings retain the existing separation rules. Missing measurements remain missing; zero success remains a real zero. Sample counts and limited-data qualifiers remain available in chart labels/tooltips and exact-data disclosures.
- Style gaps compares a trait's observed success with the same-grade baseline. Success curves compare observed rates across the server-ordered grades. Exposure plots distinct climbs against the server-provided success gap. Pyramids use separate style panels, grades from hardest to easiest, and centered sent-count overlays on total-climb tracks with a common count scale. Progress uses one mini-chart per style on a common 0–100% scale. Radar uses success percentages on that same scale and an explicit baseline.
- Radar remains selectable when fewer than three usable trait groups exist, with an explanation instead of an invented polygon. Dense trait sets retain all data; exact values and selection remain accessible without tiny chart targets.
- Progress uses calendar-month buckets clipped to the requested date window. Each climb counts once overall and once in each month it was tried, so monthly counts need not sum to the whole-period count. Missing months render gaps, not fabricated zero success. Selecting a progress point opens the overall style/grade detail, labeled as applying to the selected period rather than that month.

These extend the existing [shared contract](../../../packages/training/src/climbing-strengths.ts), [server analysis](../../../packages/server/src/services/climbing-strengths.ts), [web component](../../../packages/web/src/components/ClimbingStrengths.tsx), and [mobile component](../../../packages/mobile/components/ClimbingStrengths.tsx).

## Data and architecture

All metric values remain server-computed. The five non-temporal alternatives use the existing counts, rates, baseline, and percentage-point differences. Pyramids draw total-count tracks with send-count overlays; clients do not derive another unsent metric.

Each panel adds required `progress` entries with clipped `startDate`/`endDate` and the same row keys/grade order. Monthly cells contain `grade`, `sends`, `climbs`, `successRate`, and `sampleStatus`; they do not duplicate examples or add unused baseline metrics.

The builder accepts the required analysis date window. The router resolves an omitted anchor in the user's timezone and passes the same explicit end date to the repository and builder. The strengths cache version changes with the required response shape.

Identity, context, grade, and trait conflicts resolve over the complete requested window. Monthly outcomes then resolve from that month's original observations. A later send must not erase an earlier month's failed outcome, and a monthly split must not resurrect an identity excluded for a conflicting grade. This preserves the [existing consolidation rules](../../../packages/server/src/services/climbing-strengths.ts).

Use existing rendering tools: [ECharts](https://echarts.apache.org/en/index.html) through web `DofekChart`, and [react-native-svg](https://github.com/software-mansion/react-native-svg) with mobile `AccessibleChart`. No dependency, database schema, provider ingestion, or new HTTP service is needed.

## Approaches

The reviewed alternatives were a single preferred visualization, multiple charts shown simultaneously, and one selectable visualization. The user chose the selectable approach; it keeps the strengths page compact while retaining each chart's different analytical purpose. The existing profile remains available for continuity.

## Verification

Tests cover the shared response, real repository-to-analysis monthly outcomes, requested empty/partial months, cross-source and cross-month evidence, all view choices, retained selections, null versus zero, limited samples, short/dense axes, and safe source labels. Browser checks cover light/dark desktop and narrow mobile Storybook layouts. Reuse one coherent fixture across visualization alternatives so comparisons remain reviewable.
