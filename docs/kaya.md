# Kaya provider

The `kaya` provider connects a user’s Kaya account with their email and
password, then syncs climbing sessions and ascents from Kaya’s authenticated
application API. `kaya-export` remains a separate CSV-import provider.

Kaya does not publish this API for third-party integrations. The contract in
[kaya-api.openapi.yaml](kaya-api.openapi.yaml) is observed from the
[Kaya web app](https://kaya-app.kayaclimb.com/) and may change without notice.

For routes, Kaya’s explicit `climb.lead` boolean is stored as the canonical
nullable `fitness.climbing_entry.lead` value: `true` is lead and `false` is
top-rope. Boulder entries store `null`, because Kaya returns `false` for them
without a rope-style meaning.
