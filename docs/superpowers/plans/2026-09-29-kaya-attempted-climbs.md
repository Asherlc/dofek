# Kaya attempted climbs implementation plan

> Execution: use `superpowers:executing-plans` with explicit review checkpoints. The user approved importing attempted climbs and re-syncing the affected activity.

**Goal:** Import Kaya's unsuccessful climbing records and identify other omitted fields.

**Architecture:** Extend the existing typed Kaya client and provider mapping. Store provider-attributed raw climbing records in the existing canonical schema; web and mobile use the existing climbing API.

**Evidence:** Kaya session `3077580` returns six ascents and three `attempted_climbs`; Dofek activity `d6a03986-c1ee-45cb-9c49-a6ed5709e52f` contains six sends. The current session query omits `attempted_climbs`. Source: [Kaya application](https://kaya-app.kayaclimb.com/) and its authenticated [GraphQL endpoint](https://kaya-beta.kayaclimb.com/graphql), observed 2026-09-29.

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

- [ ] Extend the client request and parser; map attempted climbs to canonical unsent entries.
- [ ] Verify repeat syncs and both clients' rendering with focused tests and a real database integration test where needed.
- [ ] Document verified coverage and append the production incident baseline.
- [ ] Run lint, typecheck, and appropriate test tiers.
- [ ] Review checkpoint: independently review the final diff and address material findings.

## Task 3: Ship and verify the affected session

- [ ] Commit and push on the existing branch.
- [ ] Apply the corrected import through the normal release/sync path and re-sync the affected session.
- [ ] Verify production now serves the six sends and three attempted climbs.
- [ ] Report remaining field omissions and any release limitation explicitly.
