# Simplified climbing strengths

The user approved one fixed visualization in each of Styles, Grades and Progress, for both wall angle and hold type, with no grade picker or chart-format menu. The user then requested the radar in Styles and explicitly approved server-computed grade adjustment across grades.

- Styles: radar of observed minus expected send-rate differences in percentage points, from −100 to +100, with the same-grade baseline at zero. Each style uses its own known-result grade mix against the same selected-context grade baseline. Unknown-only styles remain unscored; fewer than five known outcomes is limited. At least three scored styles are required for the polygon; exact values retain all styles.
- Grades: one grade × style heatmap with supplied success rates, sparse/unknown status and source-climb selection.
- Progress: one shared 0–100% monthly send-rate plot with one line per style, using the server’s pooled All grades profile. It explicitly says that the grade mix can change. Monthly selection opens whole-period source climbs and says so.

Approaches considered: putting a grade picker inside the chart still required choosing difficulty; the all-grade line chart removed the picker but did not retain the requested strengths/weaknesses radar. The final radar uses a server-computed same-grade reference, while the two other tabs keep independent fixed views.

The score weights expected sends using each grade’s known observations, adapting [UKHSA expected-event standardisation](https://fingertips.phe.org.uk/static-reports/public-health-technical-guidance/Standardisation/Overview_standardisation.html). It is descriptive, not causal. The server owns calculation; clients only select supplied response values and map them to chart coordinates. See the [contract](../../../packages/training/src/climbing-strengths.ts) and [calculation](../../../packages/server/src/services/climbing-strength-profile.ts).

The Setting filter is the sole indoor/outdoor control. The charts combine the selected settings without setting headings or repeated setting charts. Both platforms preserve climbing-context separation, source links, cached refresh, actionable errors, true zero rates, unknown outcomes and missing observations. No dependencies or storage changes are needed. The protected API adds the computed gradeAdjustedStrengths field to each panel. The web uses [ECharts radar](https://echarts.apache.org/en/option.html#radar) and mobile uses [react-native-svg](https://github.com/software-mansion/react-native-svg).
