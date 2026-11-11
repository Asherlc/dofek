# Climbing exploration implementation

Approved direction: shared context filters, purpose-based strengths views, local
breakdown controls, and recorded-climb details. Execute inline in the existing
`scrawny-anaconda` worktree, without switching branches.

## Design and scope

- Make All climbing / Bouldering / Lead / Top rope and Setting visible above
  the charts on both clients. Keep the remaining factual filters in More filters.
- Presets modify climb kind and rope method together; independent filters remain
  intact. Advanced selections that do not match a preset remain representable.
- Strengths offers Styles / Grades / Progress. Styles defaults to a same-grade
  comparison; Grades uses the heatmap; Progress uses the existing monthly chart.
  Existing alternative formats remain available under Chart options.
- Wall angle and Hold type are breakdowns. Indoor/outdoor becomes a comparison
  option under Chart options, separate from these breakdowns. The global setting
  filter still applies to all views. Separate setting panels retain shared scales.
- Keep server-computed counts, rates, baselines, missingness and source examples.
  Pooled All grades stays available with an explicit mixed-difficulty qualifier.
- Reuse the existing chart stack; no dependency, schema, or query changes.

Alternatives considered: only moving the setting control would leave seven chart
names as the entry point; deleting all alternative formats would remove existing
exploration tools. Purpose navigation with disclosed formats provides a compact
entry point while preserving those tools. This follows
[ONS interactive-chart guidance](https://service-manual.ons.gov.uk/data-visualisation/guidance/interactive-charts-and-animations),
[PatternFly filter patterns](https://www.patternfly.org/patterns/filters/design-guidelines/),
and [NN/G tab guidance](https://www.nngroup.com/articles/tabs-used-right/).

## Tasks and review checkpoints

1. Shared presentation policy (`climbing-filters.ts`, `climbing-strengths-views.ts`):
   first test preset transitions, independent-filter preservation, custom contexts,
   and purpose selection. Implement pure presentation helpers, without metrics.
   Checkpoint: focused shared unit tests pass after observed failures.
2. Filters (`web/components/ClimbingFilters`, mobile equivalent, web climbing route):
   first test visible primary controls, setting independence, clear/reset, and
   advanced fact retention. Extract the web controls into a reusable component.
   Checkpoint: both component suites and climbing route tests pass.
3. Strengths (both components and view pickers): first test purpose switches,
   same-grade default, pooled qualifier, setting comparison, and selection retention.
   Update navigation and disclosures while retaining all chart renderers.
   Checkpoint: focused strengths suites pass, including refresh and unknown outcomes.
4. Storybook and docs: show the actual controls and strengths together on both
   clients. Update existing stories for changed defaults. Verify in the browser
   at desktop and narrow widths; run lint, typechecks, and relevant test suites.
   Checkpoint: review the final diff, commit and push all intended changes.

## Review focus

Contradictory advanced filters must not be mislabeled as a preset. Clearing a
preset must not clear setting. Source selections must survive view changes and
refreshes. Unknown settings/outcomes must stay distinguishable from zero data.
Keep any existing chart-local range override explicitly scoped rather than
suggesting it applies to the other charts.

## Working notes

- Existing queries already share context filters; existing response panels carry
  all metric values. No query-time analytics or infrastructure work is required.
- User approved execution with “lets do it”; no additional approval gate needed.
- Shared policy checkpoint: seven unit tests pass after four observed failures.
- Filter checkpoint: new web/mobile interactions pass; existing route tests adapted
  to the visible setting controls and More filters disclosure.
- Strengths checkpoint: four new navigation/comparison tests pass after observed
  missing-control failures. Existing selection/refresh tests remain in scope.
- Ruling: retain mobile's explicitly labeled strengths-only All time override.
  Other mobile training endpoints have bounded days contracts; expanding these
  contracts would add server scope unrelated to the selected UI redesign.
- Review: independent review found mobile Grades lacked the planned heatmap and
  picker stories lacked controlled comparison props. Both corrected. A follow-up
  review found the new heatmap's accessible name omitted Limited sample; added
  that qualifier with a failing regression test before fixing it.
- Validation checkpoint: 174 focused tests passed across 12 suites; web and shared
  typechecks passed. After the accessibility fix, all 25 affected mobile tests
  passed again. Final mobile typecheck and `pnpm lint:sandbox` passed. Desktop
  and narrow mobile Storybook previews were inspected, including the heatmap.

## Retrospective

Reusing the server contract kept this a presentation change. Review caught a
native heatmap parity gap and an accessible-label omission before completion.
The new cited data-exploration reference records the control model and metric
qualifiers for future work. Next time, review equivalent web/mobile Storybook
states early; retain the TDD and verification checkpoints used here. A useful
guidance refinement would explicitly require that paired visual review before
calling a cross-platform UI change complete.
