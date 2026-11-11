<!-- cspell:words getschema todouble -->

# Axiom logs, traces, metrics, and field limits

## Dataset contract

Application and infrastructure logs go to `dofek-logs`; spans go to
`dofek-traces`. Both datasets retain data for 29 days. The collector routes each
signal separately, and the environment wrapper generates signal-specific
headers for direct exporters. Axiom requires a dedicated dataset for each
OpenTelemetry signal: [OTel ingestion](https://axiom.co/docs/send-data/opentelemetry).
See the [collector configuration](../deploy/otel-collector-config.yaml),
[environment wrapper](../scripts/with-env.ts), and
[processor retention verification](../src/account-erasure/processor-retention.ts).

Host capacity is a metrics signal and uses the dedicated metrics dataset
`dofek-host-metrics` through the `x-axiom-metrics-dataset` header; query it with
MPL or the Metrics builder, not APL. See the rollout prerequisites below before
deploying.

Log exporters group metadata into a nested OTLP attribute named `custom`, stored
as the `attributes.custom` map in Axiom. The shared exporter wraps only Axiom's
export path on Node and mobile; the collector also groups metadata from its
OTLP and Docker receivers. Grouping preserves an already-mapped record. This
covers direct mobile exports and infrastructure logs without changing PostHog's
metadata shape. See the [shared exporter](../packages/telemetry/src/axiom-log-exporter.ts)
and [collector transform](../deploy/otel-collector-config.yaml).

`dofek-logs` configures `attributes.custom` as a map field. Setting the parent
`attributes` as a map alone did not group scalar attributes on the OTLP path in
the [October 23 investigation](production-incident-baseline.md#2026-10-23--axiom-log-attributes-approached-the-field-limit).
Validate the actual wire format; do not infer success from a configuration API
response. Map keys lose schema autocomplete and can cost more to query than
indexed fields:
[map fields and their trade-offs](https://axiom.co/docs/apl/data-types/map-fields).

## Queries

Discover the live schema before choosing filters. Use the authenticated Axiom
CLI; these commands do not print credentials:
[CLI reference](https://axiom.co/docs/reference/cli).

```bash
axiom query "['dofek-logs'] | getschema" --format json
axiom query "['dofek-traces'] | getschema" --format json
```

Log metadata uses map access. Fields such as `body`, `severity_text`,
`service.name`, and `trace_id` remain outside the custom map:
[map property access](https://axiom.co/docs/apl/data-types/map-fields#access-properties-of-nested-maps).

```apl
['dofek-logs']
| where _time > ago(1h)
| where ['service.name'] == 'dofek-mobile'
| project _time, body, severity_text,
    operation = tostring(['attributes.custom']['operation']),
    route = tostring(['attributes.custom']['route'])
| sort by _time desc
| limit 50
```

Trace semantic attributes retain their normal indexed paths. Axiom stores
custom span attributes in its built-in `attributes.custom` map:
[custom trace attributes](https://axiom.co/docs/apl/data-types/map-fields#custom-attributes-in-tracing-datasets).

```apl
['dofek-traces']
| where _time > ago(1h)
| where name == 'clickhouse.queue_wait'
| project _time, trace_id,
    wait_ms = todouble(['attributes.custom']['clickhouse.queue.wait_ms']),
    queue = tostring(['attributes.custom']['clickhouse.queue.name'])
```

Use the [loading monitor specifications](../scripts/loading-performance-monitors.ts)
and [loading runbook](performance/loading-performance-runbook.md) for performance
investigation. Run monitor queries against the live datasets before creating
monitors; their configuration is not automatically applied.

## Traefik server-error access logs

Traefik sends only `500`–`599` access-log records as OTLP logs to `dofek-logs`
through the unsampled `logs/app` pipeline. All fields and headers default to
`drop`, so no path, host, client identity, header, or query string is exported.
The collector moves the retained fields into `attributes.custom`; `StartUTC` and
`Duration` are integer nanoseconds. Configuration:
[Traefik access logs](https://doc.traefik.io/traefik/observability/access-logs/),
[collector config](../deploy/otel-collector-config.yaml).

```apl
['dofek-logs']
| where _time > ago(1h)
| where ['service.name'] == 'traefik'
| project _time,
    router = tostring(['attributes.custom']['RouterName']),
    service = tostring(['attributes.custom']['ServiceName']),
    method = tostring(['attributes.custom']['RequestMethod']),
    status = toint(['attributes.custom']['DownstreamStatus']),
    origin_status = toint(['attributes.custom']['OriginStatus']),
    duration_ms = todouble(['attributes.custom']['Duration']) / 1000000.0
| sort by _time desc
| limit 100
```

Because only `5xx` records are exported, an empty result does not prove the
export is healthy; confirm the path with a deliberate `5xx` during acceptance.
`RequestPath` is intentionally absent, so Sentry is the source for the failing
endpoint.

`DownstreamStatus` is the response Traefik sent to the client. `OriginStatus`
is captured around the service handler; a nonzero value can also be a `502` or
`504` generated by Traefik after a connection failure or timeout. Corroborate it
with proxy diagnostics and backend logs before attributing the response to the
backend. Zero means no upstream HTTP response was recorded and does not identify
a specific cause. Service fields can be absent when no backend was selected.
See the [Traefik 3.6.25 field middleware](https://raw.githubusercontent.com/traefik/traefik/v3.6.25/pkg/middlewares/accesslog/field_middleware.go)
and [proxy error handler](https://raw.githubusercontent.com/traefik/traefik/v3.6.25/pkg/proxy/httputil/proxy.go).

## Host capacity metrics

`system.filesystem.usage` for `/mnt/dofek-data` is exported every 30 seconds to
`dofek-host-metrics` with `service.name=dofek-host`. Query it in the Axiom
Metrics builder: dataset `dofek-host-metrics`, metric
`system.filesystem.usage`, filtered to that service and mount point, grouped by
`state`. APL does not apply to metrics datasets:
[MPL introduction](https://axiom.co/docs/mpl/introduction),
[Axiom metrics](https://axiom.co/docs/query-data/metrics).

`state` values are disjoint byte counts: `used` is allocated space, `free` is
space available to unprivileged users, and `reserved` is `total - used - free`
(root-reserved blocks). Total capacity is the sum of the three, not `used` plus
`free`. The scraper needs `include_virtual_filesystems: true` because a
same-path bind shares its backing device with another mount, and gopsutil
otherwise skips duplicate-device bind mounts; the strict mount-point filter
still limits collection to `/mnt/dofek-data`:
[hostmetrics receiver](https://raw.githubusercontent.com/open-telemetry/opentelemetry-collector-contrib/v0.149.0/receiver/hostmetricsreceiver/README.md),
[bind-mount handling](https://raw.githubusercontent.com/shirou/gopsutil/v4.26.1/disk/disk_linux.go).

## Rollout prerequisites for host capacity metrics

Before deployment, verify the existing native dataset and ingestion access:

1. Confirm `dofek-host-metrics` exists as `otel:metrics:v1` with 29-day
   retention, and that the existing `AXIOM_API_TOKEN` can write to it.
2. Confirm `/mnt/dofek-data` exists. The read-only same-path collector bind
   fails its task when the source is absent, and CI checks it first:
   [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/#syntax).
3. Validate the collector config and deploy `otel_collector_config_v4`. Swarm
   config objects are immutable:
   [Docker configs](https://docs.docker.com/engine/swarm/configs/).

## Post-deploy acceptance

- Host capacity: within two scrape intervals (60 seconds) plus ingestion delay,
  `dofek-host-metrics` has `system.filesystem.usage` for
  `service.name=dofek-host` and `mountpoint=/mnt/dofek-data` with `used`, `free`,
  and `reserved` states. The three values should sum to the volume size from
  `df -B1 /mnt/dofek-data`.
- Traefik errors: drive one request that returns `5xx`; within one collector
  batch (5 seconds) plus ingestion delay, `dofek-logs` has a
  `service.name=traefik` record whose `attributes.custom` lacks the path,
  client address, host, and headers.
- An empty result alone cannot distinguish no matching server errors from a
  delivery/query problem, even after acceptance. Check exporter diagnostics and
  the query window; when needed, verify delivery with an approved deliberate
  `5xx`.

## Field-limit investigation

Count schema fields rather than distinct field values. Start with `getschema`,
then read dataset metadata and map configuration through the documented
[dataset API](https://axiom.co/docs/restapi/endpoints/getDataset),
[field API](https://axiom.co/docs/restapi/endpoints/getFieldsForDataset), and
[map-field API](https://axiom.co/docs/restapi/endpoints/getMapFields). Use an
authorized account; the ingestion token may not have dataset-read permissions.
Keep credentials out of terminal output.

Check all ingestion paths, including mobile's direct OTLP exporter. Inspect
collector logs for rejected records and distinguish field-limit failures from
other partial-success responses. Verify a schema change with synthetic events
containing distinct attribute keys: both keys must remain queryable inside
`attributes.custom`, without adding corresponding flattened schema fields.

Grouping affects future ingestion from updated exporters. It does not collapse
historical flattened fields. Logs from older exporters use paths such as
`['attributes.operation']`; updated exporters use
`['attributes.custom']['operation']`. Historical traces remain in `dofek-logs`
until their retention period ends. Dated incident queries intentionally retain their
original paths: [map and flattened field behavior](https://axiom.co/docs/apl/data-types/map-fields#map-fields-and-flattened-fields).

Vacuum only when dataset metadata reports reclaimable fields. Vacuum removes
fields that no longer occur in retained events; it does not rewrite retained
data. Deleting fields makes historical values inaccessible, so field deletion
is not part of this procedure:
[vacuuming and field deletion](https://axiom.co/docs/reference/datasets#vacuum-fields).

Collector changes must use a new Swarm config-object version and the normal
validated deployment workflow. Swarm config objects are immutable:
[Docker configs](https://docs.docker.com/engine/swarm/configs/),
[deployment procedure](../deploy/README.md).
