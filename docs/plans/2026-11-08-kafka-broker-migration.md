# Kafka broker migration

Status: broker runtime candidate extracted; activation qualification remains open.
This is one of two independent efforts requested on November 8. The other is
account-erasure hardening. Both start at main commit
`2752451fb4a7404e5d887d32341595a42a673dcd`; neither is stacked on the other.

## Goal and boundary

Replace the production Redpanda broker with stock Apache Kafka without requiring
the account-erasure redesign or an unrelated application release. Keep the
already deployed application and archive images wherever protocol compatibility
allows. Existing deletion guarantees remain requirements, not permission to
certify remote erasure from consumer offsets.

The combined [PR #3231](https://github.com/Asherlc/dofek/pull/3231), frozen at
`ed26f38b8`, is reference material, not this branch's base or release candidate.
Its [cutover attempt receipt](https://github.com/Asherlc/dofek/blob/ed26f38b8/docs/evidence/kafka-cutover-attempt-20261108/README.md)
records the abort and recovery. Its source code, lab results and qualified
artifact digests may be reused only for matching unchanged inputs.

## Extraction and validation

- [x] Extract only broker infrastructure and necessary transport compatibility
  changes from PR #3231. Primary paths: `deploy/stack.yml`, the broker bootstrap
  portions of `.github/workflows/deploy-web-stack.yml`, required environment
  rendering in `scripts/deploy-service-environment.ts`, and the dedicated R2
  Terraform resources. Do not copy the full application workflow or source tree.
- [x] Keep ClickHouse at production 26.6 and preserve Postgres, PeerDB, analytics,
  unrelated services and application migration journals. Do not import the new
  catalog guard, identifier stores, snapshot redesign, migrations 0178/0179,
  analytics work coordination or the application-wide Kafka naming refactor.
- [ ] Verify the existing KafkaJS clients and Connect archives against stock
  Kafka using their current configuration contract. Trace any necessary change
  to an actual incompatibility. Broker migration must not silently trigger a
  new application image, topic epoch, schema migration or account-erasure release.
- [ ] Review existing broker-retention and account-erasure assumptions against
  tiered storage. Preserve fail-closed semantics. Any indispensable broker-specific
  safety change belongs here; do not pull in the unrelated erasure redesign to
  satisfy it. Record a real dependency if independent activation is impossible.
- [ ] Validate declarative configuration with native tooling and test changed
  client behavior with focused real-engine tests. Reuse relevant stock Kafka/R2
  qualification evidence rather than repeat historical identity scans or cloud
  experiments. An image/source/layout change invalidates only affected evidence.
- [ ] Prepare a broker-only operator packet that captures current images and
  offsets, pauses and drains writers, preserves old data, verifies all six
  consumers, and distinguishes pre-write reversal from post-write forward recovery.
  Do not use full-stack deployment or prune for the first cutover.

Use stock [Swarm service updates](https://docs.docker.com/reference/cli/docker/service/update/)
and [stack deployment](https://docs.docker.com/reference/cli/docker/stack/deploy/).
Kafka's [tiered-storage documentation](https://kafka.apache.org/44/operations/tiered-storage/)
defines broker remote-storage behavior; application erasure must not infer remote
physical deletion from log offsets alone.

## Release contract

This PR must be reviewable without the erasure PR. No production mutation follows
from creating this workspace or PR. Request a fresh, concrete maintenance approval
only after the broker-only candidate and rollback boundaries are qualified.
Redpanda remains running; the Kafka service remains stopped. Never delete the
retired Redpanda tree or resume a previous cutover script under old approval.

## Review focus

Existing application images must work unchanged; the six consumer/archive routes
must remain consistent; remote retention must preserve existing erasure guarantees;
full-stack automation must not upgrade databases or prune the retained broker;
the first successful Kafka write must be treated as a distinct recovery boundary.

## Extraction review record

The candidate retains `REDPANDA_BROKERS` for existing application and Connect
images. Actual-image inspection found that the separately repaired history sink
already uses `KAFKA_BROKERS`; preserve that specific service contract too.
Only the new broker gets `kafka.env`; no application naming refactor,
native publisher overhaul, transport acknowledgement migration, archive config
version bump, or ClickHouse upgrade is included. Source ownership and remaining
qualification requirements are recorded in [the broker guide](../../deploy/kafka/README.md).

Review checkpoint: the frozen full-stack topic bootstrap depended on the new
application route/epoch model. It was not copied. Normal application deployment
instead requires an already activated broker and existing source/quarantine
topics; first activation must use a separately qualified broker-only packet.
This keeps the normal release from silently creating a new transport generation.

Review checkpoint: current replay-expiry verification compares low offsets and
does not prove physical remote erasure. Resolving that compatibility is a real
activation prerequisite, without importing the unrelated erasure redesign.
See [Kafka's remote deletion design](https://cwiki.apache.org/confluence/display/KAFKA/KIP-405%3A+Kafka+Tiered+Storage).

Local verification: 27 focused environment-rendering tests passed, including
eight tests first observed failing before broker rendering was extracted.
Root TypeScript typecheck, Biome for both changed TypeScript files, Terraform
1.16.6 initialization/validation/formatting, Docker stack configuration rendering
with non-secret placeholders, and the repository's Actionlint mode passed.
Standalone Actionlint with ShellCheck also reports existing quoting diagnostics
in unchanged workflow scripts; the added bootstrap quoting diagnostics were fixed.
No current-image real-engine qualification, full-suite pass, production plan/apply,
application build or activation is claimed.

Further qualification: the four existing broker integration tests passed on
stock Kafka 4.4.0. Both deployed application digests passed direct factory
payload checks using their respective broker-variable contracts. All three
deployed Connect routes preserved synthetic records through the original gzip
pipeline and committed offsets, with local file output replacing S3. See
[the qualification record](../../deploy/kafka/qualification.md) for fixture,
scope and cleanup details. This establishes bounded protocol compatibility,
not full service boot, R2 delivery or physical remote erasure.

The [cutover packet](../../deploy/kafka/cutover-packet.md) now records immutable
service images, all six route boundaries and pre/post-write recovery classes.
It remains non-executable: unchanged-worker physical erasure is not established,
and exact topic identities and retirement authorization remain unresolved.
