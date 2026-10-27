<!-- cspell:words getschema todouble -->

# Axiom logs, traces, and field limits

## Dataset contract

Application and infrastructure logs go to `dofek-logs`; spans go to
`dofek-traces`. Both datasets retain data for 29 days. The collector routes each
signal separately, and the environment wrapper generates signal-specific
headers for direct exporters. Axiom requires a dedicated dataset for each
OpenTelemetry signal: [OTel ingestion](https://axiom.co/docs/send-data/opentelemetry).
See the [collector configuration](../deploy/otel-collector-config.yaml),
[environment wrapper](../scripts/with-env.ts), and
[processor retention verification](../src/account-erasure/processor-retention.ts).

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
