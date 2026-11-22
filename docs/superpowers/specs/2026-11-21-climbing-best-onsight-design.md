# Best recorded onsight

Show each climber their highest confirmed whole-climb onsight grade over the previous 12 calendar months on the existing climbing training pages on web and iOS. The [approved canvas](../../../design/climbing-best-onsight/design.json) places the result with Grade Progression. The fixed window ends on the user's current local calendar day. It includes that day and excludes the same date 12 calendar months earlier.

The matrix has Gym and Outdoor columns and rows for Bouldering, Lead, Top rope, Follow, and Unroped. A result shows the recorded grade as the link to that send in Dofek's existing climb detail viewer. An empty cell shows a dash with an accessible description. The date line shows the window. Source and grade provenance belong in the existing record viewer.

Use the recorded climb date, even when a log is attached to an activity with another date. Standalone logs with dates qualify on the same basis. Require the canonical confirmed free onsight on one whole-climb attempt. For a route, use the method from that exact attempt. Require a known setting on the stored climb. The [existing outdoor catalogue default](../../../drizzle/0180_climbing_log_location.sql) leaves the stored setting unknown. Respect account ownership and analytics access windows.

Prefer a compatible published grade. If no published grade can be ranked, use a compatible grade reported on the ascent. Preserve the original winning grade and scale, and compare ranks with the [existing grade order](../../../packages/training/src/climbing-grades.ts). Break equal ranks by newer ascent date and then a stable record identifier. Unknown grades, methods, settings, dates, and execution evidence stay unknown.

[Draper et al.](https://pubmed.ncbi.nlm.nih.gov/21491325/) compared a self-reported 12-month best onsight sport-lead grade in 29 competitive climbers with an indoor assessed sport-lead climb. The app's grade is a descriptive best from recorded ascents. The paper supplies the time window and the lead context, and the matrix preserves the other types and settings as their own recorded results.
