# BoardSesh grade display

## Approved scope

The user approved retaining personal grades in `reportedGrades`, retaining
BoardSesh consensus/model grades in each log's source payload, and computing
`displayGrade` on the server. Their BoardSesh **Show Boardsesh grades** setting
is enabled. Existing Climb identity and wall-angle fields remain unchanged.
There are no new tables, dependencies, provider preferences, or migrations.

Production diagnosis: activity group `324ed832-9b72-4bac-b6dc-5eaa0972c1d6`
contains seven BoardSesh logs, each with raw `difficulty: null`, no personal
grade, and no published grade. The importer only requests personal difficulty.

## Source and behavior

Match the upstream logbook's [crowd-grade selection](https://github.com/boardsesh/boardsesh/blob/db98d3f3902b96f1df0d8be96410c27d1de860e3/packages/shared/logbook/src/grade-display.ts)
and [grade-label formatting](https://github.com/boardsesh/boardsesh/blob/db98d3f3902b96f1df0d8be96410c27d1de860e3/packages/shared/play-view/src/grade-display.ts).
Use rounded Boardsesh difficulty when present except confidence `setter_only`,
`cross_angle_estimate`, `moonboard_angle_estimate`, or
`moonboard_wide_angle_estimate`; otherwise use consensus. A personal logged
grade remains separate and takes display precedence, as in the app's logbook.
Preserve board-specific labels and V-grade `+` formatting from the source
grade catalogue. Do not infer labels by converting between grading scales.
Source fields are documented in the upstream [Tick schema](https://github.com/boardsesh/boardsesh/blob/db98d3f3902b96f1df0d8be96410c27d1de860e3/packages/shared-schema/src/schema/ticks.ts).

## Task order and acceptance

### 1. Import and render BoardSesh grades

- Read repository policies and relevant READMEs. Stay on the current branch.
- Write regression tests and observe the missing-grade case fail before code.
- Extend `src/providers/boardsesh.ts`'s existing ascent metadata query/schema
  with consensusDifficulty, consensusDifficultyName, boardseshDifficulty,
  boardseshConfidence, and angle. Validate exact tick/climb/mirror AND angle
  matches before using metadata. Keep source metadata and the board's grade
  catalogue under `raw.metadata`; retain the catalogue even when a metadata
  page omits a tick. Do not replace `reportedGrades` with consensus.
- Use one small server helper under `packages/server/src/repositories/` for
  BoardSesh grade parsing/selection/formatting. Consume it in
  `climbing-activity-log-entry-repository.ts` for both display and sorting.
  Existing other-provider behavior is unchanged. Never assign the tick's
  angle-specific grade to shared `climb.publishedGrades`.
- Keep the existing server response contract: both web and mobile render
  `displayGrade`. No client arithmetic or new UI setting.
- Tests cover ungraded tick with model grade, personal-grade preservation and
  precedence, blocked confidence fallback, absent grades, unknown tiers,
  rounding, V+ formatting, board label differences, wrong-angle metadata,
  same climb at different angles, and non-BoardSesh isolation. Put helper tests
  next to the helper; existing TS files must stay <=1,000 lines.
- Update `docs/boardsesh.md` to describe the mapping and re-sync requirement,
  citing the pinned upstream source. Record production diagnosis in the
  incident baseline with unresolved live rollout status.

### 2. Verify and review

- Run relevant non-interactive unit/provider/repository tests and record JSON
  reports and logs under `/tmp/opencode/boardsesh-grades/`.
- Run required `pnpm lint`, all-package typechecks, and relevant unit/mobile
  tests. Initialize workspace Compose configuration and ClickHouse for lint
  using the repository wrapper. No local E2E, new dev server, or deployment.
- Review the actual diff for scope, source fidelity, angle isolation,
  preservation of personal grades, and both-client rendering.
- Commit and push after successful required checks. Report any blockers
  explicitly; do not weaken gates. Production needs deployment followed by a
  normal BoardSesh re-sync before the seven existing records gain grades.

## Progress

- Design approved in conversation; implementation and regressions are complete.
- Focused tests passed 166/166, real-engine integration passed 20/20, and live
  upstream parity passed 14/14. Full lint and all-package typechecks passed.
- Final unit/mobile run: 24,764 passed, zero failed, 19 skipped.
- Review round 1 identified V+ ordering and missing isolation regressions;
  both were corrected with failing-then-passing regressions. Independent
  re-review found no remaining material findings.
- Deployment and the normal BoardSesh re-sync remain pending; the seven
  existing activity-group records are unchanged.

## CI follow-up: mutation coverage

- User requested fixing CI on PR #3356.
- Run `43784341173`, `Check Server / Stryker (0)` and `(1)`, failed in
  `Run Stryker`: final scores 65.38 and 64.71 below the unchanged 75 threshold.
- Downloaded mutation JSON reports identify uncovered personal catalogue,
  malformed/partial source-label, fallback, and repository unknown-grade paths.
- Add focused behavioral tests through existing public helper/repository APIs,
  preserving existing coverage and the 1,000-line limit. Remove redundant
  implementation branches only when equivalent behavior is proved; do not
  alter exclusions, thresholds, retries, or workflow gates.
- Reproduce the two exact CI mutation targets locally, fix material findings,
  run relevant lint/typechecks/tests, commit and push, then monitor the new CI
  run to a passing conclusion. Record the incident and verification evidence.
- Local verification complete: exact helper target 77.24%, exact repository
  target 100%, full unit/mobile suite zero failures, lint and all-package
  typechecks passed. Independent review found no material issue. Remote CI
  verification is tracked on PR #3356; no gate or exclusion was changed.
