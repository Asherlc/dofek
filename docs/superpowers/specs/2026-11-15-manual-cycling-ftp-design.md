# Replace estimated cycling FTP with a manual setting

Status: approved by the user on 2026-11-15; implementation in progress.

## Intent and user direction

The user requested removal of estimated FTP, then specified that an activity
with power and no user-configured FTP should show a link to the FTP setting.
This supersedes the computed-only direction in the dated
[2026-11-01 design](2026-11-01-computed-cycling-eftp-design.md).

User clarification during implementation: retain the estimation algorithms behind
an explicitly invoked button beside the FTP input, show method options/results,
and require the user's choice. Do not automatically save or apply suggestions.

Use the user's entered FTP as the sole threshold for cycling power zones,
intensity factor, and power training stress. Preserve recorded power, normalized
power, work, power-duration observations, and the separate Critical Power
analysis. Do not introduce automatic estimation, model-based decay, provider FTP
fallback, or automatic update of the user's setting.

## Approach and alternatives

Restore FTP in the existing effective-dated `fitness.sport_settings` table and
its settings API. This reuses the existing user/sport/date identity instead of
adding profile state or a separate threshold-history framework. The user selected
manual FTP by requesting an FTP-setting link. Removing all threshold-dependent
metrics would unnecessarily remove useful behavior after FTP is configured;
replacing eFTP with another estimator conflicts with the removal request.

Date handling follows the existing sport-settings contract; it is not a
fitness-aging model. Estimation suggestions retain their stated scientific
limitations and never become saved thresholds automatically.

## User experience

- Add a Cycling FTP section in Settings / Models & Units on web and mobile.
  Provide a whole-watt positive FTP input, the existing effective-date concept
  with today's date as the default, Save, and a way to clear FTP. Display save,
  validation, loading, and error states using existing form patterns.
- Beside the FTP input, provide an explicitly invoked estimation action. Show
  suggestions from the retained reference-curve algorithm and the commonly used
  95% of 20-minute best power method, with method, evidence ride/date/duration,
  selected date range and limitations. Use recent evidence by default (90 days
  ending on the chosen effective date), with editable date bounds; never silently
  search all history. The [TrainingPeaks threshold guidance](https://help.trainingpeaks.com/hc/en-us/articles/204071934-How-to-Calculate-Threshold-Values-for-Power-Heart-Rate-or-Pace)
  describes the 20-minute method. An ordinary ride's best effort is not known to
  be maximal: clearly explain that easy-only riding can underestimate FTP. The
  reference-family method is an estimate, not an exact Intervals.icu reproduction
  or individually validated FTP. Show unavailable methods explicitly when their
  evidence is absent/outside supported coverage. Choosing a suggestion fills the
  input for review; only Save writes the dated manual setting. Running estimates
  or selecting an option must not change settings, zones, load or cache state.
  Critical Power remains separately named and does not become an FTP suggestion.
- Use the existing sport-settings history to edit values applying to earlier
  rides. Do not silently apply a newly entered current value to years of history.
  Date defaults and activity dates use the user's/activity's local calendar date,
  not an implicit UTC day. Entering a historical value is an explicit user action.
- Activity power remains visible with no FTP. If an activity has power but lacks
  an applicable FTP setting, show one concise “Set FTP” link at its power-zone
  section, opening the FTP setting directly. A settings section target must be
  available on both clients; carry the activity date so its effective date can
  be prefilled. Neither navigating nor saving should invent a threshold.
- Do not show an FTP reminder on an activity without power. Do not show the
  reminder while the setting is still loading or when its request failed.
  Recorded zero-watt samples count as power availability; incomplete coverage
  does not suppress the missing-FTP link when power is present.
- With a configured FTP and valid power coverage, retain power zones, intensity
  factor, and training stress using that value. Missing coverage still has its
  separate explanation. Zero power is a valid recorded value, not missing data.
- Remove automatically maintained computed-eFTP values, provenance disclosures,
  trends, and estimated-FTP availability messages from both clients. Keep the
  explicitly invoked settings suggestions described above. Do not add a manual-FTP
  trend chart. Preserve unrelated heart-rate and training-load analyses.

## Storage and server calculation

- Add a forward Postgres migration restoring a nullable positive whole-watt FTP
  column to `fitness.sport_settings`; do not populate it from eFTP or resurrect
  the removed profile FTP column. Keep one user-entered source of truth.
- Extend the existing sport-settings repository and API for reading, saving, and
  clearing FTP. Ensure partial FTP updates do not erase unrelated HR, pace, zone,
  or notes settings. Resolve the latest setting effective on or before each
  activity's local date; handle a cleared FTP explicitly rather than falling back
  to an older value. Current reads exclude future-dated settings.
  An FTP-only save on a new effective date inherits unrelated values from the
  applicable preceding settings row. Clearing writes an explicit null entry;
  deleting an entire dated settings row intentionally exposes its predecessor.
  Rows remain full settings snapshots, matching the existing table contract:
  omitted values are preserved/copied at save time, and correcting an earlier
  snapshot does not rewrite any later snapshot. Do not introduce per-field
  inheritance markers or a second history representation.
- One activity date selects FTP everywhere: use the canonical activity's recorded
  source-local date (recorded timezone/offset according to the existing activity
  date resolver), falling back to the user's timezone only when source-local
  information is absent. A chart's analysis/grouping timezone never changes the
  threshold selected for that activity. Test a ride near midnight with differing
  source/user/analysis dates across activity, calendar, load, and MCP consumers.
- Replace computed threshold evidence with configured-value provenance: watts,
  setting identity, and effective date. Resolve settings in bulk for an activity
  set; do not add one Postgres query per activity.
- Preserve the existing server-owned normalized-power projection and its source
  invalidation, completion eligibility, missing-data semantics, and account-erasure
  fence. Remove the per-user eFTP history reconstruction/publication stage and its
  history-decay policy. Retain the reference bank and candidate algorithm only
  for the manually invoked settings suggestions.
- Keep expensive sensor computations in analytics. Compute the inexpensive
  threshold-dependent arithmetic from existing normalized power and duration
  plus manual FTP in one shared server/domain path. Intensity factor is NP/FTP;
  power training stress is `(NP/FTP)^2 * elapsed_seconds / 36`, following the
  [published TrainingPeaks definition](https://www.trainingpeaks.com/learn/articles/estimating-training-stress-score-tss/).
- Remove threshold dependence from the normalized-power serving view. Update
  calendar, cycling, activity details, comparisons, load, PMC, and MCP consumers to
  resolve the same applicable manual FTP. Preserve unavailable results as null;
  do not substitute zero load or silently omit an unsupported ride from a total.
- Invalidate all affected cached query domains after FTP save, clear, or deletion,
  and bump persisted response versions where contracts change. A saved setting
  must affect subsequent reads without waiting for an analytics rebuild.

## Removal and migration boundary

Remove ongoing-eFTP trend/history APIs and their registrations, chronological
estimator history and unused application-only helpers. Replace the ongoing
estimate wrapper with an explicitly invoked, bounded suggestion query using
existing power-duration observations; never scan raw sensor history on request.
Retain the calibration bank for that action. Preserve independently useful pure normalized-power,
stress, regression, and Critical Power algorithms. Audit the public numerical
package's exports before deleting a reusable public API; app feature removal
does not require a gratuitous library API break.

Add a forward ClickHouse migration replacing the power-metrics serving view with
normalized-power observations plus activity metadata, then dropping obsolete
eFTP views/history storage after every current consumer has been replaced.
Update dbt source declarations, model selection, migration bootstrap, erasure,
and other relevant registrations together. No full historical sensor backfill is
needed: the normalized-power observations already exist. Migration operations
must preserve raw sensor samples and activity records.

The web, server, worker, and mobile contract change is a coordinated release;
document the old-mobile-client boundary in the cutover notes rather than adding
a compatibility estimator or silently fabricated responses. Production deployment
is separate from implementation and local migration validation.

## Implementation scope

- Storage/settings: `src/db/schema/activity.ts`, forward migrations,
  `packages/server/src/repositories/sport-settings-repository.ts`,
  `packages/server/src/routers/sport-settings.ts`, and cache invalidation.
- Projection/serving: `src/analytics/cycling-power-projector.ts`, its policy,
  `src/db/cycling-power-schema.ts`, relevant dbt models, and
  `scripts/run-analytics-build.ts`.
- Consumers/contracts: cycling threshold/power/PMC/activity repositories and
  routers, analytical load and calendar repositories, comparison contracts, and
  MCP registration/output contracts.
- Clients: FTP settings sections, activity power missing-setting prompts, cycling
  views, removed eFTP components, matching stories, and persisted-cache versions
  in both `packages/web` and `packages/mobile`.

## Acceptance and required validation

1. An activity with power and no applicable FTP renders “Set FTP”; following it
   reaches the FTP field with the activity date. An activity without power does
   not show the prompt. Loading/error states do not masquerade as missing FTP.
2. Saving a valid manual FTP makes applicable zones and stress metrics available
   on subsequent reads; a lower user-entered FTP is accepted. Clearing it restores
   the missing-setting state without falling back to computed or older FTP.
3. Earlier/later dates, future settings, same-day edits, user isolation, partial
   updates, and setting deletion follow the documented effective-date rules.
4. Power observations, mechanical work, zero samples, incomplete coverage, and
   Critical Power analysis remain correct independently of FTP availability.
5. All zones/load consumers use manual FTP. Estimates are calculated/displayed
   only after explicit invocation in settings and require explicit choice plus
   Save. Running suggestions never writes settings; old evidence outside the
   selected range cannot leak in. Missing 20-minute/reference evidence remains
   unavailable; easy-only data has an explicit limitation. API and persisted
   cache contracts match both clients.
6. Observe behavior regressions fail before implementation and pass afterward.
   Follow the removal test policy: update/delete obsolete tests rather than
   testing that removed code does not exist. Execute real Postgres/ClickHouse
   migration and query behavior tests; run `pnpm migrate` locally.
7. Run required lint, all-package typechecks, relevant noninteractive unit/mobile
   tests, integration tests, and final whole-change review. Review visual and
   accessible missing/entered/error states on both clients. Use the existing
   Firefox session for browser checks. No local E2E run unless E2E tests change.

## Task order and review checkpoints

Confirm this design, then write the implementation plan. Restore manual storage
and settings behavior first; replace projection/consumer threshold reads next;
complete both clients; finish migrations, required verification and separate
whole-change review. Review scope, maintainability, and verification after each
meaningful chunk; commit and push each passing chunk on the current branch.
