# @dofek/kaya-client

Typed client for Kaya’s observed application login and GraphQL API. It is not
an official Kaya SDK; the protocol is derived from the
[Kaya web app](https://kaya-app.kayaclimb.com/).


Both logbook queries request climb color (`color { name }`) and retain it with
name, grade, and source identifiers, including when the climb name is null.
See the [observed Kaya API contract](../../docs/kaya.md#confirmed-request-coverage).

Session attempted climbs also request and validate the non-null `sent` Boolean
beside `attempts: session_attempts`. The importer retains this source status;
older imports acquire it on their next sync. See the
[attempt occurrence contract](../../docs/kaya.md#attempt-occurrences) and Kaya's
[attempt/send logging guide](https://kayaclimb.com/support-articles/logging-your-climbs-on-kaya).
