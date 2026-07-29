# Record-local time context

Activities and sleep sessions store their absolute boundaries as PostgreSQL
`timestamptz` values and separately retain the trusted local-time context that
was resolved when the record was ingested. PostgreSQL converts timestamp-with-
time-zone input to UTC and does not retain the original zone, so the separate
context is required to state the original clock time later. See the PostgreSQL
documentation for [date/time input and time-zone handling](https://www.postgresql.org/docs/current/datatype-datetime.html#DATATYPE-TIMEZONES).

The context consists of:

- `timezone`: an IANA zone only when the provider or recording device supplied
  that zone.
- `start_utc_offset_minutes` and `end_utc_offset_minutes`: resolved
  independently so a record that crosses a daylight-saving transition retains
  both clock offsets.
- `local_time_source`: `provider_timezone`, `provider_offset`,
  `device_timezone`, `device_offset`, or `unknown`.

`unknown` is deliberate. Ingestion must not substitute the current viewer,
profile, server, or request timezone when the record did not carry trusted
context. Clients render “Local time unavailable” rather than presenting a
guessed clock time.

## Historical activity backfill

Migration `0064_record_local_time_context` is schema-only. Historical activity
rows that already contain a provider-supplied IANA `timezone` can be populated
after deploy with a separate bounded command. Sleep rows and activities without
retained trusted context remain `unknown`.

Start with the default dry run:

```bash
pnpm backfill:record-local-time
```

The command scans at most 20 batches of 250 rows. Invalid stored zones are
reported as skipped and are not rewritten. Choose explicit smaller bounds when
operating under load:

```bash
pnpm backfill:record-local-time -- --batch-size=100 --max-batches=5
```

After reviewing the candidate and skipped counts, execute the same bounds:

```bash
pnpm backfill:record-local-time -- \
  --batch-size=100 \
  --max-batches=5 \
  --execute
```

Repeat the dry run. Advance the bounds only when the updated count matches the
expected valid candidates. The update is idempotent: it only writes rows whose
source is still `unknown`, and it resolves the start and end offsets from the
stored IANA zone independently.

Stop if the skipped count is unexpected, database health degrades, or the
updated count differs from the valid candidate count. Investigate invalid zones
instead of replacing them with a profile or server timezone.
