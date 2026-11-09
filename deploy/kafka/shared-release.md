# Shared application release after the Kafka cutover

Kafka phase 1 is complete; this is the **separate normal application release
proposal**, not permission to repeat the cutover. The [execution receipt](phase1-execution.md)
records the approved topic policies, preserved old data, image contracts and
successful 30-minute observation. Tiering remains a later release in PR #3236.

## Reviewed artifact and executable scope

[Build Docker 42554799318](https://github.com/Asherlc/dofek/actions/runs/42554799318)
successfully built source `3350bbb7814063579fa2a268ccb23ca0aa4c087b` for Linux ARM64:

```text
ghcr.io/asherlc/dofek@sha256:54214d6276f03c5d96ae02ba75e91b7fc0fecd63c8b416ec36b7548a866a651b
```

This is the application image, not the separately pinned Apache Kafka broker.
It runs as UID/GID 1000 with `./entrypoint.sh`, Node 26.13.0 and
`SENTRY_RELEASE` equal to that full source revision. Local qualification compared
38 packaged production source/config files with that checkout and exercised the
actual `retention_verification` phase with six structural checkpoints. Covered
local files, retained Redpanda data, unexpected tiering and a changed topic
generation all rejected completion; native file absence allowed the phase to
continue. The Admin responses and other retention dependencies were synthetic;
this does not replace the earlier native-broker cleanup/restart proof or qualify
unrelated retention services. See the [image receipt](../../docs/evidence/kafka-shared-release-20261109/summary.json).

The packaged sink, event identity, metric writer, KafkaJS consumer, entrypoint
and migration histories match merged main `afa8b6e46` (#3235). In particular, the
new shared history sink uses `REDPANDA_BROKERS`, while the currently deployed
separately repaired history image uses `KAFKA_BROKERS`. Preserve the repair's
behavior and change the image/environment together; do not carry the old image's
broker-key name into the new source or add a dual-key fallback. The renderer
supplies `REDPANDA_BROKERS` to all three new sink instances. See the
[consumer factory](../../src/metric-stream/redpanda-consumer.ts),
[service renderer](../../scripts/deploy-service-environment.ts) and
[phase-1 pins](phase1-execution.md).

Changes after this image build affect deployment rendering, deployment-test
fixtures, fresh-host cloud-init and documentation. They do not change the
application executable paths in this image. The image's revision is **3350**, not
the later documentation/deployment-fix head. The normal release must resolve and
verify its own exact source/digest through the existing
[image resolver](../../scripts/resolve-deploy-image.ts); this review pin cannot be
substituted under another source revision.

## What merging releases

The existing [Deploy Web workflow](../../.github/workflows/deploy-web.yml) can
run after successful main CI. It selects the release, runs the Cloudflare
Terraform root, then the full application stack. Its ordinary automatic path
also starts matching OTA/iOS workflows after successful production deployment.
This is broader than replacing the broker or the narrow phase-1 worker.

The [stack workflow](../../.github/workflows/deploy-web-stack.yml) performs these
existing operations:

1. Export/validate Infisical configuration, require Redpanda stopped and Kafka
   already active, and verify the mounted data filesystem, native Kafka API and
   exact topic names before creating the Apple key secret.
2. Pull/verify the requested shared image, validate the stack, publish web assets
   and sweep expired database backups under the existing retention policy.
3. Apply dependencies with the migration-running worker and ClickHouse consumers
   quiesced; run the requested image's one-shot migrations. Both tracked
   migration histories are unchanged from the old application baseline; this
   establishes no new migration IDs, not blanket compatibility or no data
   mutations in other release steps.
4. Roll out the requested shared application image, including web, worker, sinks,
   analytics, CDC health and reconciliation; run provider-connection and PeerDB
   contract/readiness steps; restore the quiesced consumers after the gates pass.
   Archive consumers are not quiesced by the CDC overlay. Web follows the
   existing rolling/maintenance selection.
5. Verify convergence, running image identity and Kafka API after the applicable
   stack boundaries. A paused/rolled-back Kafka update fails. No new timeout,
   retry, lock service or broker bootstrap mechanism is introduced.

The worker returns from the phase-1 explicit Node command to the image's normal
`entrypoint.sh worker`, including its existing migration launcher. Its two
read-only Kafka/retained-Redpanda mounts remain in the canonical stack. Confirm
the actual resulting command, mounts, image and routes after release; a rendered
stack alone is not task-state evidence. See [entrypoint.sh](../../entrypoint.sh),
[stack.yml](../stack.yml) and the [migration overlay](../stack.migration-quiesce.yml).

The broker stays on the same data directory, cluster/topic identities, six
application topics and approved 4 GiB/1 GiB limits with remote storage disabled.
No second topic generation, offset reset, old-data deletion or R2 activation is
part of this release. The retained Redpanda directory still prevents erasure
completion until separately approved retirement. Existing archive and backup
gates remain independent; archive existence is not a tested restore guarantee.
See the [phase-1 receipt](phase1-execution.md) and [runtime guard](../../src/account-erasure/kafka-log-storage.ts).

## Infrastructure and verification limits

The read-only Cloudflare-root
[plan 42549866789](https://github.com/Asherlc/dofek/actions/runs/42549866789)
at `8a9c8de03c910a36f2f7dac397317e992324bf6e` reported **No changes**. Subsequent
Cloudflare Terraform edits only clarified comments; managed R2 resources remain
declared. No apply or credential update was performed for this assessment.

The separate OCI root now bootstraps the canonical Kafka directory on a verified
mounted data filesystem and owns it as UID/GID 1000. Template/YAML/shell parsing,
Terraform formatting and validation passed offline. This changes OCI instance
`user_data` and requires a separate OCI plan/replacement review before any future
OCI apply. The normal release applies `deploy/`, not `deploy/oracle-free/`; the
Cloudflare No-changes result does **not** qualify the OCI change. See
[the environment workflow](../../.github/workflows/deploy-web-environment.yml),
[OCI compute definition](../oracle-free/compute.tf) and
[bootstrap](../oracle-free/cloud-init.yml).

The actual Docker Stack loader exposed a Kafka renderer defect: copying dotenv
quotes into `CLUSTER_ID` preserved the quote characters. The renderer now emits
the parsed, validated 22-character structural identity without quotes. Five new
cases failed first; all 26 renderer cases and a real `docker stack config`
qualification passed afterward. This used synthetic values and no engine or
production secrets. Docker's [Stack loader](https://github.com/docker/cli/blob/master/cli/compose/loader/loader.go)
uses its literal env-file parser; the [CLI maintainers' explanation](https://github.com/docker/cli/issues/3630)
distinguishes that behavior from shell/dotenv parsing.

## Decisions still required before merge and automatic release

These are actual outstanding choices, not requests to repeat completed checks:

- **Terraform managing credential:** the workflow obtains
  `CLOUDFLARE_TERRAFORM_R2_API_TOKEN` from the GitHub `terraform` environment.
  Its prior presence/comment is not approval of an Infisical-policy exception.
  Choose a narrowly scoped exception for this Terraform-only managing credential,
  or authorize moving its source to the existing Infisical OIDC path. No token
  value, credential transfer, rotation or policy change is authorized here.
- **Internal broker trust:** broker/controller listeners are unauthenticated
  PLAINTEXT on the stack overlay, with no published host ports. A compromised
  attached workload can still access/administer Kafka. Keeping this selected
  trust boundary needs an explicit review disposition; internal-only networking
  is not a SASL/ACL fix. No new authentication architecture has been implemented.
- **Production release:** approve merging #3233 with the normal full release
  effects above, after current-head required CI/review gates settle and the
  exact automatic release image is resolved. The earlier Q4 cutover approval
  does not cover this broader action. Keep one operator responsible for a
  non-overlapping release window and the existing stop/preserve/forward-recovery
  boundary; do not route new Kafka writes back to old Redpanda.

Tiered-storage activation, erasure-branch combination/six-field scrub preservation,
old-data retirement and any OCI apply remain separate decisions. No production
mutation follows merely from this proposal or from a successful image build.
