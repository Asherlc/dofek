# Native Peloton workout origin

The user approved identifying native Peloton rides as the workout origin while retaining independent WHOOP recordings. Production diagnosis found a native `platform=home_bike`, `deviceType=home_bike_plus` workout, its Strava `Peloton Bike` copy, and WHOOP with an Apple Health copy. Both databases returned no primary origin; see the [incident evidence](../../production-incident-baseline.md#2026-10-27--peloton-ride-had-no-primary-source-label).

## Approach

Extend the existing initiating-origin policy in the [PostgreSQL resolver](../../../drizzle/_views/00_activity_origin.sql) and [ClickHouse macro](../../../analytics/macros/activity_origin.sql). Recognize a native Peloton bike recording using normalized `platform=home_bike` and `deviceType` of `bike` or `home_bike_plus` (the existing parser fixture and observed production values). Recognize normalized Strava `Peloton Bike` source/device labels as Peloton attribution. Keep transfer evidence separate from independent recordings.

Adding only the missing Strava edge leaves the WHOOP branch unresolved. Using provider priority would discard the resolver's evidence-based policy. The user selected native initiation; the exact two device values and normalization are implementation choices based on retained evidence and the [parser fixture](../../../packages/peloton-client/src/parsing.test.ts).

## Constraints and verification

Preserve conflict/cycle checks and unresolved results for multiple initiating origins. WHOOP-imported Peloton records and incomplete or contradictory native metadata must not gain initiating status. Do not infer Peloton-to-WHOOP transfer. Keep both database engines equivalent and use a forward-only PostgreSQL function migration. Existing shared server results drive both clients; no client calculation or provider preference is needed. Extend shared behavioral fixtures, reproduce the failure in both real engines, then validate the view's primary fields and exact transfer evidence through PostgreSQL and ClickHouse integration tests.
