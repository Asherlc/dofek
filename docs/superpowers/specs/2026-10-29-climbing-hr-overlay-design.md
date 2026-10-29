# Climbing overlays on heart rate

Show recorded climbs against heart rate on web and mobile so users can relate
effort to climbs. The user approved markers for timestamps, shaded bands for
known start/end boundaries, and climb names/grades on hover or tap. Date-only
logs do not qualify; never substitute ingestion or session timestamps.

## Approaches

Use annotations on the existing time charts (chosen): preserves alignment and
uses the existing ECharts/SVG renderers. A separate timeline would require
synchronizing two views; inferring climb boundaries would invent timing.
ECharts provides native [time markers and regions](https://echarts.apache.org/en/option.html#series-line.markArea).

The server projects annotations from retained source facts and preserves them
when consolidating logs. KAYA ascent/export records supply `date`; only explicit
timezone-qualified instants qualify. Current records supply no climb end times.
The shared annotation contract represents instants and ranges; clients only
position and format these values. Out-of-chart annotations are hidden and
overlapping ranges clipped to the plot. Names and grades remain available to
keyboard and screen-reader users as well as pointer users.

No database migration, backfill, new dependency, inferred boundaries, or metric
calculation on clients is required.
