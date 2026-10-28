# Combined climbing grade progression

The user approved one Grade Progression chart across all selected climbing types,
then clarified that it should use one stack per period across selected settings as
well. Page filters choose records; the chart does not repeat type or setting
breakdowns.

The server pools raw graded observations before calculating sends, distinct
climbing days, grade segments, rates, stack positions, and axis values. A date
present under several types or settings counts once in its period. Failed and
unknown outcomes retain recorded days, known zero remains distinct from missing
periods, and boulder, route, and retained source grade scales remain identifiable.
Keep the [existing saved grade preferences](../../../packages/server/src/repositories/climbing-repository.ts)
when resolving display grades; pooling does not introduce any additional conversion.
This follows the existing
[server metric rule](../../../AGENTS.md) and [data exploration guidance](../../data-exploration.md).

Use one nullable response object, with grades identified by kind, scale and label;
periods contain aggregate counts and grade segments. Both clients render the
server values with one legend, timeline, and accessible data disclosure. Preserve
mobile period selection and refreshed details. Do not introduce additional grade conversion,
new controls, dependencies, or a client aggregation path.

Alternatives considered: removing only Focus retained unwanted panels; combining
existing lane rates would count overlapping days incorrectly; separating by scale
was declined in favor of one combined chart. Keep resolved display grade labels and qualify
only collisions. Order by kind/scale and then difficulty within each scale.
