# Sleep stage lanes

Approved direction: the user selected design A from the two interactive mockups on November 16, 2026.

Replace filled step charts with four labeled lanes, ordered Awake, REM, Light,
Deep. Solid rounded blocks occupy only their recorded lane and start/end interval;
their widths remain proportional to elapsed time. Unrecorded gaps stay blank.
Use the shared sleep-stage palette and existing web/mobile chart libraries.

Web hover/tap and mobile tap show the stage, start, end, and duration. Exact values
remain available through accessible chart-data disclosures, including keyboard
access on web. Compute interval duration in the server response, without storing
derived values or changing sleep-session selection. Preserve loading/empty states,
independent night navigation, and the existing time-zone formatting.

Approaches considered: A's separate lanes encode stage by both position and color;
B's continuous ribbon is more compact but relies on color. The user chose A.
No new dependencies, sleep totals, source selection, or ingestion changes are needed.
Blank gaps (rather than the mockup's hatching) use the simplest existing rendering.

Acceptance: both clients show four separate lanes, proportional opaque intervals,
blank gaps, readable labels, and exact interval details. Tests exercise real web
SVG output and mobile geometry/selection, with stories for overnight data, gaps,
short awakenings, single-stage nights, empty data, and web loading.

Implementation reference: [ECharts custom series](https://github.com/apache/echarts-doc/blob/master/en/tutorial/custom-series.md)
supports mapping start/end dimensions to a time axis and rendering interval rectangles.
