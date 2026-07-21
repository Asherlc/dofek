# E2E metric-stream prerequisites implementation plan

## Problem

The isolated E2E stack reports the server healthy even though it cannot save a recorded mobile activity. The save request fails at runtime with `METRIC_STREAM_TOPIC is required` because `docker-compose.e2e.yml` provides neither the metric-stream environment configuration nor a Redpanda broker.

This leaves browser-only E2E checks green while a normal authenticated write path is unusable, and defers a required-prerequisite failure until a user completes a recording.

## Evidence

- Started the documented isolated `docker-compose.e2e.yml` stack; migrations, analytics, and the server healthcheck all passed.
- A signed Release iOS simulator build recorded a running activity, reached Save, and received the exact server error `METRIC_STREAM_TOPIC is required`.
- `docker-compose.e2e.yml` omits both `METRIC_STREAM_TOPIC` and `REDPANDA_BROKERS` from the server and defines no Redpanda service.
- The normal local Compose stack configures Redpanda and supplies both values to metric-stream producers.

Primary evidence: [`docker-compose.e2e.yml`](../../../docker-compose.e2e.yml),
the normal [`docker-compose.yml`](../../../docker-compose.yml), and captured
runtime reproduction [#1806](https://github.com/Asherlc/dofek/issues/1806).
Docker documents health-gated dependency startup and the `--wait` readiness
contract in its [startup-order guide](https://docs.docker.com/compose/how-tos/startup-order/)
and [`compose up` reference](https://docs.docker.com/reference/cli/docker/compose/up/).

## Implementation

1. First add an executable integration/E2E test that saves a minimal recorded activity and fails with the current missing `METRIC_STREAM_TOPIC` prerequisite.
2. Add a Redpanda service to the isolated E2E topology using the repository's current pinned broker version and an isolated, healthchecked internal listener.
3. Set `REDPANDA_BROKERS` and `METRIC_STREAM_TOPIC` explicitly on the E2E server, make server startup depend on broker health, and ensure the topic is available through normal producer behavior or an explicit idempotent E2E initialization step.
4. Strengthen E2E readiness so required write-path infrastructure cannot be absent while the test server is declared ready.
5. Add negative setup tests that remove the broker, `REDPANDA_BROKERS`, and `METRIC_STREAM_TOPIC` one at a time and assert readiness fails immediately while naming the missing prerequisite.

## Acceptance criteria

- The isolated E2E stack starts with a healthy metric-stream broker and explicit producer configuration.
- Saving a recorded activity succeeds without manually injecting environment variables.
- A missing broker or required metric-stream key fails setup/readiness immediately with the missing prerequisite named.
- Existing web E2E tests remain isolated and pass.

## Validation

- Recreate the isolated E2E stack from empty volumes.
- Run migrations, analytics, browser E2E, and the new recording write-path test.
- Save a short simulator recording and confirm the app reaches the successful post-save path.
