# Climbing strengths controls

Approved direction: implement the interactive mockup discussed in this session.

- All grades combines distinct climbs into one result per style. A specific
  grade filters the results. Rates and differences come from the server.
- Keep the grade control only where it changes the view. Grade profile,
  success curves and grade pyramids continue to show individual grades.
- All time must query the accessible history, bounded by the selected end date.
- Missing aid use means free climbing. Merge those observations before
  counting distinct climbs. Explicit aid remains separate.
- Keep context choices short, without unknown/not-recorded qualifiers. Remove
  the verbose context dropdown in favor of visible choices on both clients.
- Retain the previously implemented removal of Coverage, repeated context
  descriptions and instructional text, and the Progress label-overlap fix.
- No client-side metric calculation, storage migration or new dependencies.

The earlier separate-charts and overlaid-grades alternatives were rejected:
All removes grade grouping. Existing server aggregation remains the source of
truth; clients render its computed results. The contract uses a separate
all-grades projection, so aggregate values never become a fake grade column.

Use existing React and React Native controls. Preserve button selection state
and labels following the [WAI button pattern](https://www.w3.org/WAI/ARIA/apg/patterns/button/).
