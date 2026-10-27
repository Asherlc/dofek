# Data exploration design

This is Dofek's design guidance for web and mobile analytics. It applies the
research below to the product; exact defaults remain product decisions that
should be checked with realistic data and user tasks.

## Controls and scope

Keep four operations distinct: filters choose records, breakdowns group those
records, metrics define values, and presentations choose how to draw them.
This distinction follows the tasks described in
[Interactive Dynamics for Visual Analysis](https://idl.cs.washington.edu/files/2012-InteractiveDynamics-CACM.pdf).

Put shared filters above the charts they affect and local controls inside the
chart section. Keep frequent choices visible and disclose less common factual
filters. Preserve advanced selections, including explicit unknowns. Show selected
values once: add removable labels when collapsed controls conceal them, rather
than duplicating already-visible single selections. See
[PatternFly's filter guidance](https://www.patternfly.org/patterns/filters/design-guidelines/).

Use immediate updates for fast exploration. Consider an Apply action when users
set several criteria together or queries are slow. Preserve the user's position
and make refresh state visible. This trade-off depends on intent and response
speed, as described in [NN/G's filtering research](https://www.nngroup.com/articles/applying-filters/).

## Views and comparison

Start with a useful view, then offer purpose-based navigation and details on
selection. Do not require users to learn chart names before finding information.
Avoid exposing every available format in the initial interface. See
[ONS interactive-chart guidance](https://service-manual.ons.gov.uk/data-visualisation/guidance/interactive-charts-and-animations).

| Task | Starting presentation |
| --- | --- |
| Compare categories | Horizontal bars or dots |
| Follow change over time | Lines with visible missing intervals |
| Scan grade and style patterns | Heatmap with exact values |
| Compare settings or contexts | Paired marks or aligned small charts |
| Inspect individual observations | Records or a table |

These are starting choices, informed by
[Datawrapper's chart-selection guide](https://www.datawrapper.de/blog/chart-types-guide)
and [NN/G's perception guidance](https://www.nngroup.com/articles/dashboards-preattentive/),
not a requirement to turn every dataset into a chart.

Use common scales for comparable panels. Bars start at zero; differences use
an explicitly labeled zero baseline. Avoid dual axes. Keep category order and
heatmap percentage scales consistent during comparison. See
[ONS axes guidance](https://service-manual.ons.gov.uk/data-visualisation/guidance/axes-and-gridlines).
Use visible simultaneous comparisons when users need to compare categories;
switching between tabs places that comparison in memory. See
[NN/G tab guidance](https://www.nngroup.com/articles/tabs-used-right/).

## Interpretation and access

Keep the denominator, period, and data limitations discoverable alongside a rate.
Do not present missing data as zero. Show uncertainty when it materially changes
interpretation; avoid adding statistical decoration without an appropriate model.
See [ONS uncertainty guidance](https://service-manual.ons.gov.uk/data-visualisation/guidance/showing-uncertainty-in-charts).

Keep labels readable on narrow screens, support keyboard and native accessibility
selection, and expose essential chart information as text or a table. Color and
hover should not be the only way to obtain information. See
[W3C guidance for complex images](https://www.w3.org/WAI/tutorials/images/complex/).

## Climbing implementation

The [web filters](../packages/web/src/components/ClimbingFilters.tsx) and
[mobile filters](../packages/mobile/components/ClimbingFilters.tsx) share context
presets while retaining independent factual facets. Setting narrows all climbing
queries; it is separate from Wall angle and Hold type breakdowns.

The [shared strengths navigation](../packages/training/src/climbing-strengths-views.ts)
offers Styles, Grades and Progress. Styles starts at an individual grade; All
grades is an explicit pooled view with a mixed-difficulty qualifier. Chart options
discloses additional formats and setting comparison. The existing strengths-only
All time override on mobile is labeled locally; the training date selector still
controls the other charts. Values and counts come from the
[server response contract](../packages/training/src/climbing-strengths.ts).

Review these interactions in the paired Storybook stories with multiple contexts,
unknown outcomes, missing traits, empty periods, and refreshed responses. Successful
selection should explain which records are visible and how to return to a broader
view. ONS recommends user testing and regularly reviewing dashboard measures in
its [dashboard guidance](https://service-manual.ons.gov.uk/data-visualisation/guidance/dashboards).
