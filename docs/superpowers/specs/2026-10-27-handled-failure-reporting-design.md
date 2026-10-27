# Handled failure reporting

The user approved classifying handled offline/cancelled requests and confirmed
invalid credentials as operational outcomes, retaining unexpected failures as
exceptions, and removing duplicate diagnostic exceptions. They also requested
metrics for these outcomes.

Use a shared classifier in `@dofek/telemetry` for the two clients. Only known
transport shapes and an explicit server credential-failure marker qualify;
HTTP status alone and arbitrary message substrings do not establish an expected
failure. Keep errors visible to callers. Retain existing background timeout and
connection-loss classification without claiming that delivery will succeed.

Record client outcome counts through the existing PostHog event pipeline and
mobile structured logs, with fixed failure categories. Record provider lifecycle
outcomes through the existing OpenTelemetry counter pipeline. Do not install a
new client metrics exporter or put user IDs, URLs, or error text in metric labels.
PostHog supports [counting events](https://posthog.com/docs/product-analytics/insights/trends).

Remove synthetic credential lifecycle exceptions: callers retain responsibility
for reporting unexpected failures. Preserve unknown HTTP authorization rejection
diagnostics, malformed responses, storage failures, and unhandled exceptions.
Serialize a confirmed invalid-credentials category through the existing tRPC
error formatter so web and mobile can apply the same policy.

Alternatives considered: changing only Sentry alert rules leaves duplicate
PostHog issues; global message filtering can conceal unrelated defects. The
approved approach classifies handled outcomes in application reporting while
retaining logs and [breadcrumbs](https://docs.sentry.io/platforms/javascript/enriching-events/breadcrumbs/).

No new retry, timeout, recovery promise, environment variable, or dependency on
a new external service is needed. Regression tests cover both destinations,
unknown failures, explicit credential evidence, wrapped transport errors, and
metric privacy. Rollout and physical-device validation remain separate from
local test results.
