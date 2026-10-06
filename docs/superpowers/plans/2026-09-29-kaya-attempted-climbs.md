# Kaya attempted climbs implementation plan

> Execution: complete the tasks in order. At each review checkpoint, compare the implementation with the observed API contract and regression results; resolve material findings before proceeding. The user approved importing attempted climbs and re-syncing the affected activity.

**Goal:** Import Kaya's unsuccessful climbing records and identify other omitted fields.

**Architecture:** Extend the existing typed Kaya client and provider mapping. Store provider-attributed raw climbing records in the existing canonical schema; web and mobile use the existing climbing API.

**Evidence:** An affected session's authenticated Kaya response contains both ascents and `attempted_climbs`, while Dofek contains only its sends. The current session query omits `attempted_climbs`. Source: [Kaya application](https://kaya-app.kayaclimb.com/) and its authenticated [GraphQL endpoint](https://kaya-beta.kayaclimb.com/graphql), observed 2026-09-29. Production identifiers and workout details are omitted from this public record; regression fixtures use synthetic identifiers and locations.

## Constraints and review focus

- Preserve raw provider data; do not invent unrecorded attempt counts.
- Confirm the live response shape before implementing its parser.
- Retain separate records when Kaya reports both an ascent and attempts.
- Verify both web and mobile presentation, pagination, malformed payloads, and repeat syncs.
- Audit omitted fields; do not add unrelated schema or product features.

## Task 1: Confirm the contract and reproduce the missing import

- [x] Inspect attempted-climb fields and compare known session/ascent fields with the current requests.
- [x] Add client and provider regression tests using the observed response shape.
- [x] Run the focused tests and verify they fail because unsuccessful records are omitted.
- [x] Review checkpoint: confirm counts, source IDs, and nullability against live evidence.

## Task 2: Implement and validate

- [x] Extend the client request and parser; map attempted climbs to canonical unsent entries.
- [x] Verify repeat syncs and both clients' rendering with focused tests and a real database integration test where needed.
- [x] Document verified coverage and append the production incident baseline.
- [x] Run lint, typecheck, and appropriate test tiers.
- [x] Review checkpoint: independently review the final diff and address material findings.

## Task 3: Ship and verify the affected session

- [x] Commit and push on the existing branch.
- [x] Apply the corrected import through the normal release/sync path and re-sync the affected session.
- [x] Verify production now serves both sends and attempted climbs for the affected session.
- [x] Report remaining field omissions and any release limitation explicitly.

**Production result:** The user approved deploying the verified commit while five native Apple checks waited for runners. [Deployment 36656856783](https://github.com/Asherlc/dofek/actions/runs/36656856783) released `525ad724bcf0e12ddd58699299010e526acfe2e6` successfully. The bounded re-sync completed on its first run without errors. Read-only production verification returned both sends and unsent climbs, preserved unknown counts and known summary sends, and verified that the activity loads the corrected web assets. The protected PR remains open pending required CI; no merge bypass was used.
