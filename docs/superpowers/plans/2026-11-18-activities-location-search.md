# Activities Location Search Implementation Plan

**Goal** Add named and geographic location search to Activities on web and iOS.

**Architecture** Add an authenticated location router that searches PostgreSQL climbing areas or ClickHouse route centroids and hydrates matches through the existing calendar repository. Both clients use the same endpoints to find matches and select public places.

**Spec** [Activities location search](../specs/2026-11-18-activities-location-search-design.md)

## Step 1. Place lookup and activity matching

- [x] Add HTTP-boundary tests for `searchActivityPlaces()` in `packages/server/src/services/activity-place-search.test.ts`. Verify labeled choices, no results, and provider errors. Run the suite and observe the failure before implementing the Geoapify call.
- [x] Add a real-database test for `ActivityLocationSearchRepository.findCandidates()` in `packages/server/src/repositories/activity-location-search-repository.integration.test.ts`. Cover case-insensitive ancestor and gym matches without GPS, proximity, ownership, sport, and keyset pagination for equal timestamps. Observe the failure before implementing the repository.
- [x] Expose `activityLocation.places` and `activityLocation.search` from `packages/server/src/routers/activity-location.ts`. Hydrate IDs through `ActivitiesCalendarRepository.findByIds()` to reuse visibility and existing cards. Keep the Geoapify key in the web service environment and verify that routing with the existing environment-renderer tests.
- [x] Verify the focused unit and integration tests and review the API inputs, ownership predicates, and request data sent to Geoapify. Exercise encrypted pagination after a stale activity is rejected and verify redaction at the HTTP and database boundaries.

## Step 2. Web and iOS Activities

- [x] Add interaction tests for the web search controls and in `packages/mobile/app-tests/(tabs)/activities.test.tsx`. Exercise named search, selecting a public place, changing sport, paging, clearing, and lookup errors. Observe the failures before editing the screens.
- [x] Extend `packages/web/src/pages/ActivitiesPage.tsx` and `packages/mobile/app/(tabs)/activities.tsx` with the location option. Call the location search on submit and call public lookup on request. Use accessible controls and existing feedback and card rendering.
- [x] Run both focused suites and review parity, loading, and clearing stale selections.

## Step 3. Validate and push

- [ ] Run full lint, recursive typechecks, relevant unit and mobile tests, and the real database tests. Review the full diff and document configuration and behavior in the relevant READMEs.
- [ ] Commit and push validated work on the current branch. Record any production credential or verification blocker.
