# Automatic climbing locations implementation plan

**Approved scope:** Automatically group differently named gyms using corroborating location/name evidence, fill missing locations from an unambiguous exact source session, and show the resolved location normally without an inferred label. The user requested execution on November 13. Preserve raw records and reject ambiguous matches.

**Architecture:** Resolve locations in the existing server log projection, using its existing `areaGroupId`, `areaPath`, and `mapLocation` response fields. Existing explicit group membership takes precedence. Automatic response group identities use a deterministic source Area UUID; they are computed grouping keys, not new stored AreaGroup rows. No new dependencies, schema, aliases, external service or background job is needed. Name normalization already exists in the catalogue library; its outdoor route identity policy remains unchanged.

## Task 1: Pure location resolver

- [x] Add failing service regressions for Pacific Pipe and another unrelated gym, nearby different gyms, distant chain branches, absent coordinates, outdoor areas, conflicting explicit groups, ambiguous same-provider candidates, and transitive proximity chains.
- [x] Resolve indoor Areas across providers only with coordinates within 200 metres and compatible meaningful name tokens. Ignore generic facility words, retain distinguishing branch words, and require either equal remaining tokens or at least two shared tokens covering the smaller token set. The distance is an application heuristic allowing gym-map pin variation; proximity never suffices alone.
- [x] Only accept a candidate component when every pair is compatible and membership is unambiguous; never merge distinct explicit groups. Retain singleton grouping identities for indoor Areas to prevent the legacy name-only fallback from undoing conflict decisions.
- [x] Fill unlocated indoor logs only from active, same-owner/provider source-session peers with one resolved gym. Preserve known locations, raw records, board identity, ordering, counts and occurrences. Test missing/invalid IDs, ownership/provider isolation, conflicting sessions and metadata changes.
- [x] Run the focused tests, review scope and maintainability, commit and push.

## Task 2: Repository projection and session context

- [x] Add a real PostgreSQL regression proving automatic cross-provider gym grouping and location recovery for a single-log detail read using an unselected session peer. Observe failure before wiring the resolver.
- [x] Reuse the existing owned/visible repository projection for session context. Fetch only exact provider/session peers when an unlocated requested log needs context; respect source absence, deletion and access windows. Do not substitute a date or merged activity for source session identity.
- [x] Verify raw storage is unchanged, conflicting/absent peers do not fill locations, and existing explicit mapping survives source sync.
- [x] Run repository integration and focused service/client tests, review scope and maintainability, commit and push.

## Task 3: Whole-change validation

- [x] Update the source-location documentation and incident record with the shipped behavior, evidence and remaining limits.
- [x] Run full lint, recursive package typechecks and non-interactive unit/mobile tests; reuse successful unchanged-code results after prose edits. Review matching and missing-location rendering on both existing clients; add regression coverage where needed without adding an inferred label.
- [x] Obtain a separate whole-change review, address material findings with regression tests, push the final branch and inspect CI. Report deployment separately from source validation.

## Review focus

Keep neighboring gyms, chain branches and outdoor subareas separate. Avoid order-dependent or transitive merges. Preserve owner/provider isolation, explicit mappings, and raw provenance. Reject session ambiguity across requested and unselected eligible peers. Existing history should resolve at read time without a resync or manual mapping.

## Checkpoints

- Planning: user-approved approach recorded; no manual production mapping performed.
- Task 1: complete. Twelve original resolver failures reproduced before implementation; the final resolver and repository unit selection passes 137 tests.
- Task 2: complete. Both new PostgreSQL regressions failed before wiring; all 50 final projection tests pass, including peer eligibility and preserved native map points. Existing response fields keep both clients compatible without a new label or response version.
- Review: independent Architect review identified conflicting wall ancestry and native map replacement; all three reproductions observed RED then GREEN. No material finding was deferred.
- Maintenance: moved existing source-session and Kaya fixture builders to the existing test-helper module and consolidated repeated mock repository construction, keeping the expanded unit file within the 1,000-line limit.
- Validation: full lint and recursive typechecks passed; full local unit/mobile validation hit three unchanged-suite failures and the three subsequently corrected review regressions. Focused current checks pass; broad-suite diagnosis and mutation verification remain tracked separately from production deployment.
- Final validation: the three unchanged suites pass all 78 tests in isolation; broad-run stability remains unresolved. Targeted mutation validation passes at 78.99 against the unchanged 75 gate. A local read-only preview of the reported production activity preserves all 15 source records, resolves one gym group, and fills both missing locations. Draft PR #3338 is pushed; CI is queued and no production deployment has occurred.
