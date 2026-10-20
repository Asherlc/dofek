# @dofek/kaya-client

Typed client for Kaya’s observed application login and GraphQL API. It is not
an official Kaya SDK; the protocol is derived from the
[Kaya web app](https://kaya-app.kayaclimb.com/).


Both logbook queries request climb color (`color { name }`) and retain it with
name, grade, and source identifiers, including when the climb name is null.
See the [observed Kaya API contract](../../docs/kaya.md#confirmed-request-coverage).
