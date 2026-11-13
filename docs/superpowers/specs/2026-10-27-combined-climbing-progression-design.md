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
The [server projection](../../../packages/server/src/repositories/climbing-grade-progression.ts)
supplies the metric values rendered by clients, following the
[data exploration guidance](../../data-exploration.md).

The V2 procedures return one nullable response object, with grades identified by kind, scale and label;
periods contain aggregate counts and grade segments. Both clients render the
server values with one legend, timeline, and accessible data disclosure. Preserve
mobile period selection and refreshed details. Do not introduce additional grade conversion,
new controls, dependencies, or a client aggregation path.

Alternatives considered: removing only Focus retained unwanted panels; combining
existing lane rates would count overlapping days incorrectly; separating by scale
was declined in favor of one combined chart. Keep resolved display grade labels and qualify
only collisions. Order by kind/scale and then difficulty within each scale.

## Supported API versions

On October 28, the user approved permanent versioned procedures to preserve
the existing response contracts for older web and installed mobile clients:

| Procedure | Response |
| --- | --- |
| `climbing.gradeProgression` | Complete V1 array of type/setting lanes |
| `climbing.gradeProgressionV2` | Combined progression object or null |
| `mobileDashboard.training` | V1 training data with the lane-array progression |
| `mobileDashboard.trainingV2` | V2 training data with the combined progression |

The current clients explicitly call V2. V1 and V2 share canonical observation
retrieval, with independent projections: combined date counts cannot reconstruct
the original per-lane denominators. Both versions remain supported; no temporary
aliases, client fallback, or duplicate storage are introduced. This follows
[API compatibility guidance](https://google.aip.dev/180) and the principle of
[explicitly supported API versions](https://google.aip.dev/185).
