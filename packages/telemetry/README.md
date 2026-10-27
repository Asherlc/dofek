# @dofek/telemetry

Shared Axiom log export for Node services and the mobile app.

`AxiomLogExporter` wraps the Axiom OTLP exporter and groups log attributes into
the `custom` map. It leaves the source record intact so other destinations can
export the original attributes. Already grouped attributes remain in one map.
Axiom stores map entries without adding a dataset field per key; see its
[map-field documentation](https://axiom.co/docs/apl/data-types/map-fields).

The decorator copies the complete readable log record and delegates export,
flush, and shutdown through the standard
[OpenTelemetry exporter interface](https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_sdk-logs.LogRecordExporter.html).
It imports SDK types only and reuses the SDK already supplied by each consumer.

```typescript
import { AxiomLogExporter } from "@dofek/telemetry";

const axiomExporter = new AxiomLogExporter(new OTLPLogExporter());
```

`classifyHandledFailure` from `@dofek/telemetry/handled-failure` shares the
web/mobile policy for handled offline requests, cancellations, and explicitly
marked invalid credentials. Unknown authorization, parse, and storage failures
remain exceptions. The classifier is independent of SDK exporters. See the
[application reporting policy](../../docs/sentry.md#handled-operational-failures)
and Sentry's [handled error guidance](https://docs.sentry.io/platforms/javascript/usage/).
