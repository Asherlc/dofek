# @dofek/kaya-client

Typed client for Kaya’s observed application login and GraphQL API. It is not
an official Kaya SDK; the protocol is derived from the
[Kaya web app](https://kaya-app.kayaclimb.com/).


Both logbook queries request climb color (`color { name }`) and retain it with
name, grade, and source identifiers, including when the climb name is null.
See the [observed Kaya API contract](../../docs/kaya.md#confirmed-request-coverage).

Both feeds also retain climb tags (`id name color icon tag_type_id`),
descriptions and verified source metadata. Ascents request their own grade and
photo/video metadata separately from the climb's catalogue grade. The
[source inventory](../../docs/climbing-trait-coverage.md#kaya-field-inventory)
distinguishes current selections, authenticated checks and intentional
exclusions; the contract comes from the [observed endpoint](https://kaya-beta.kayaclimb.com/graphql)
and [application fragments](https://set.plastick.rocks/GuidebookView-11950.js.map),
not a published SDK or exhaustive upstream schema.

The client retains source values; provider-specific interpretation belongs in
the [Kaya adapter](../../src/providers/kaya-sync.ts). In particular,
[Plastick's outdoor editor](https://set.plastick.rocks/GuidebookView-11950.js.map)
uses integer codes for named wall-angle categories. The client must preserve
those integers without labeling them as measured degrees.

Session attempted climbs also request and validate the non-null `sent` Boolean
beside `attempts: session_attempts`. The importer retains this source status;
older imports acquire it on their next sync. See the
[attempt occurrence contract](../../docs/kaya.md#attempt-occurrences) and Kaya's
[attempt/send logging guide](https://kayaclimb.com/support-articles/logging-your-climbs-on-kaya).
