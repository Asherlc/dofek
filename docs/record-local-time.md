# Record-local time context

Activities and sleep sessions store their absolute boundaries as PostgreSQL
`timestamptz` values and separately retain the trusted local-time context that
was resolved when the record was ingested. PostgreSQL converts timestamp-with-
time-zone input to UTC and does not retain the original zone, so the separate
context is required to state the original clock time later. See the PostgreSQL
documentation for [date/time input and time-zone handling](https://www.postgresql.org/docs/current/datatype-datetime.html#DATATYPE-TIMEZONES).

The context consists of:

- `timezone`: the trusted IANA zone supplied by the provider or recording
  device, or the resolver-selected GPS/home zone used as a fallback.
- `start_utc_offset_minutes` and `end_utc_offset_minutes`: resolved
  independently so a record that crosses a daylight-saving transition retains
  both clock offsets.
- `local_time_source`: `provider_timezone`, `provider_offset`,
  `device_timezone`, `device_offset`, `user_home_timezone`, `gps_timezone`,
  `home_zone_fallback`, or `unknown`.

`unknown` is deliberate. Ingestion never substitutes the current viewer,
server, or request timezone when the record did not carry trusted context.
For activity providers, GPS coordinates establish the reference zone when
available; otherwise the user's configured geographic `homeTimezone` does.
Provider or device context that differs from that zone's offset by more than
60 minutes at the activity instant is retained in the
`rejected_provider_*` audit fields and replaced with the reference-zone
context. The source is recorded as `gps_timezone` or `home_zone_fallback`.
When neither reference exists, ingestion records `unknown`; the historical
repair fails its preflight rather than guessing.
The IANA database distinguishes location zones from fixed-offset zones and
documents the reversed POSIX signs in the `Etc` area in its
[theory file](https://data.iana.org/time-zones/theory.html).

## Historical activity backfill

Migrations `0064_record_local_time_context` and
`0101_user_home_timezone_context` are schema-only. Historical activity rows
that already contain a provider-supplied IANA `timezone` can be populated after
deploy with a separate bounded command. The command also repairs fixed
`Etc/GMT` provider zones only when that user has already saved a valid
`homeTimezone` setting. Sleep rows and activities without retained trusted
context remain `unknown`.

Migration `0101` installs its replacement checks as `NOT VALID`, so deploy does
not retain an access-exclusive table lock while scanning existing rows. After
deploy, validate both constraints as a separate monitored operator action
before running the data backfill.

Start with a dry run over an explicit half-open UTC time window:

```bash
pnpm backfill:record-local-time -- \
  --start-at=2025-01-01T00:00:00.000Z \
  --end-at=2025-02-01T00:00:00.000Z
```

The command scans at most 20 batches of 250 rows. Invalid stored or configured
zones are reported as skipped and are not rewritten. Confirm the affected user
has saved the intended geographic `homeTimezone` before repairing fixed zones.
Choose explicit smaller bounds when operating under load:

```bash
pnpm backfill:record-local-time -- \
  --start-at=2025-01-01T00:00:00.000Z \
  --end-at=2025-02-01T00:00:00.000Z \
  --batch-size=100 \
  --max-batches=5
```

After reviewing the candidate and skipped counts, execute the same bounds:

```bash
pnpm backfill:record-local-time -- \
  --start-at=2025-01-01T00:00:00.000Z \
  --end-at=2025-02-01T00:00:00.000Z \
  --batch-size=100 \
  --max-batches=5 \
  --execute
```

Repeat the dry run with the same time window. Advance `--start-at` and `--end-at`
only when the updated count matches the expected valid candidates. The update
is idempotent and resumable: it uses compare-and-set on each row's prior source,
paginates eligible rows by ID within the required time window, and resolves the
start and end offsets from the selected IANA zone independently.

Stop if the skipped count is unexpected, database health degrades, or the
updated count differs from the valid candidate count. Investigate invalid zones
instead of replacing them with a profile or server timezone.
