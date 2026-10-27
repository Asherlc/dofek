# Ride Detail Metrics Implementation Plan

**Goal:** Hide indoor/virtual cycling distance and display recorded mechanical energy output on web and mobile activity details.

**Approved approach:** Reuse the existing cycling modality classification and server-side workout calculation. Add a narrow power-work query over full samples rather than integrating the downsampled chart stream or multiplying average power by elapsed duration.

**Architecture:** `activity.powerWork({ id, powerSourceId? })` returns `{ workKilojoules, coverage: { coveredSeconds, coveragePct } }`. Resolve the owned canonical activity window before reading power. Both clients render this result and follow the selected power source. Mechanical output uses kJ: watts are joules per second ([NIST](https://www.nist.gov/glossary-term/34606)).

## Constraints and review focus

- Preserve outdoor zero distances; hide indoor/virtual distances even when simulated values are nonzero.
- Preserve measured zero power and distinguish it from absent data.
- Reuse the existing gap/coverage calculation; show “Partial power data” below 99% coverage.
- Preserve previous results during source refetches and display server errors.
- Do not store computed totals, add dependencies, change branches, or consume calorie-expenditure estimates.

## Task 1: Server calculation

- [x] Add failing endpoint/unit and executable ClickHouse tests for canonical ownership, source selection, gaps, zero and missing power.
- [x] Add a narrow full-sample loader and call the existing workout calculation.
- [x] Expose the cached, authenticated `activity.powerWork` query and run targeted tests.

## Task 2: Web and mobile details

- [x] Add failing presentation tests for indoor/virtual distance, outdoor distance, kJ totals, valid zero, partial coverage, errors and source selection.
- [x] Apply the existing cycling modality guard and render server-provided energy output.
- [x] Add a web header story and update package documentation.
- [x] Run focused tests, typechecks, lint and a browser visual check.

## Completion

- [x] Independently review the complete diff and resolve actionable findings.
- [x] Prepare the current branch for commit and push after validation.

Validation: 236 focused unit tests, 80 mobile detail tests and 13 real ClickHouse
integration tests pass. Root, server, web and mobile typechecks pass, as do
`lint:sandbox`, changed-file Biome checks and whitespace checks. Browser review
confirms the indoor header and partial-coverage qualifier. Review identified
cross-activity placeholder reuse; regression tests now restrict retained output
to source changes within the same activity.

Execution notes and test evidence are maintained during implementation; review uses [Google’s code-review dimensions](https://google.github.io/eng-practices/review/reviewer/looking-for.html).
