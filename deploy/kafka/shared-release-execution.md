# Kafka shared application release — 2026-11-09 UTC

**The approved application release succeeded.** Post-release verification found
one unresolved quarantine-configuration discrepancy; the deployment succeeded,
but the packet's complete topic-policy qualification did not. See the
[sanitized receipt](../../docs/evidence/kafka-shared-production-release-20261109/summary.json).
Tiered storage has not been activated.

## Approval, source and release path

The user answered **“Approved.”** to Q5: merge #3233 and perform the normal shared
release, retaining the selected internal PLAINTEXT trust boundary and the narrow
GitHub `terraform`-environment exception for
`CLOUDFLARE_TERRAFORM_R2_API_TOKEN`. The decisions were recorded in the
[broker thread](https://github.com/Asherlc/dofek/pull/3233#discussion_r4509454151)
and [credential thread](https://github.com/Asherlc/dofek/pull/3233#discussion_r4509454308).
No credential value/source was changed by the operation.

[#3233](https://github.com/Asherlc/dofek/pull/3233) merged at 04:32:06 UTC as
`6fe1d4fbd479cc1ed9be874538e2b7dc3c1b1551`. Its tree exactly matches approved
head `7699423c9`. [Main CI](https://github.com/Asherlc/dofek/actions/runs/42562370508)
passed with 90 successful jobs. Its exact Linux ARM64 application image is:

```text
ghcr.io/asherlc/dofek@sha256:9dec51d5dba7ac3b234be2defbdaa63c5d677675470f35bff320df4c365eaa20
```

The registry's OCI revision and `SENTRY_RELEASE` both match the full merge SHA.
This is distinct from the earlier `3350` review image.

The expected automatic handoff did not occur because the repository's
`Deploy Web` workflow was `disabled_manually`. Its reason, owner and disable date
were not established. That setting was left unchanged. The already existing
[manual Deploy dispatcher](../../.github/workflows/deploy.yml) was used once,
with `target=web`, `image_tag=sha-6fe1d4f` and `ref=main` while main was the exact
approved merge. It skipped both builds and retained the same canonical
Cloudflare/image/readiness/migration/CDC/restoration gates. No new workflow or
manual Swarm deployment path was introduced.

[Release 42564567850](https://github.com/Asherlc/dofek/actions/runs/42564567850)
ran from 04:57:27 to 05:25:58 UTC and succeeded. Cloudflare Terraform reported
**0 added, 0 changed, 0 destroyed**. The separate OCI root was not applied.
Migrations, requested-image rollout, Kafka checks, CDC causal verification,
consumer restoration, image/stability checks and backup freshness passed.

The manual web target does not publish optional OTA/iOS releases. The `all`
target would force native publication under `workflow_dispatch`; it was not
selected. The Kafka PR has no `packages/mobile` delta from prior main `afa8b6e46`.
No claim is made that older native dependency changes already on main were
published by this operation.

## Actual production checks

The [service contract receipt](../../docs/evidence/kafka-shared-production-release-20261109/contracts.json)
records all eight shared-image services on the exact `9dec…` digest. Actual
worker container inspection confirmed `./entrypoint.sh` with `worker`, replacing
the narrow phase-1 Node override. Its Kafka and retained-Redpanda binds are both
read-only. The new history sink uses the current source's `REDPANDA_BROKERS`
contract and contains the merged history repair; the old separately pinned
history image's `KAFKA_BROKERS` contract was not carried into the new image.

Kafka's image, environment and data mount match the pre-release specification;
remote storage remains disabled. A read-only check **inside the actual released
UID-1000 worker** used the existing `KafkaLogStorage.capture` implementation and
real Admin API/native files. It verified the original cluster identity and all
six topic generations. Its existing completion check rejected retained Redpanda
data as expected, without creating an erasure request or writing to Kafka. See
the [worker receipt](../../docs/evidence/kafka-shared-production-release-20261109/worker-guard.json).

Both observations found ten healthy Kafka/app/consumer tasks, six Stable groups
with one member each and zero lag, and ready archive consumers with zero errors.
At 05:34:39 UTC, free data space was **43,099,762,688 bytes (40.14 GiB)**, above
the approved 20 GiB reserve; root free space was 10,951,753,728 bytes. The live
archive's `output_sent` counter reached 13 after its task restart. This is an
acknowledged-output counter, not a byte-rate estimate or archive-restore test.
The public app returned HTTP 200. See the
[first](../../docs/evidence/kafka-shared-production-release-20261109/observation-first.json)
and [final](../../docs/evidence/kafka-shared-production-release-20261109/observation-final.json)
metadata observations.

Canonical stack pruning removed the already-stopped Redpanda **service**. The
original `/mnt/dofek-data/redpanda` and aborted Kafka
`/mnt/dofek-data/kafka/data` directories remain in place. No retained data was
retired, moved or deleted. The Redpanda completion hold remains active.

## Open defect: quarantine startup clears other topic overrides

The actual post-release config audit failed on `segment.bytes`: expected
`134217728`, observed `1073741824`. All three source topics retain their explicit
128 MiB segments, 4 GiB byte targets, seven-day time ceilings and remote=false.
All three quarantine topics retain correct delete/seven-day/1 GiB retention
settings, but their segment size is now the **default 1 GiB**; remote=false also
comes from the default rather than the original explicit topic override.

The frozen [before-client configs](../../docs/evidence/kafka-shared-production-release-20261109/topic-policy-before-clients.json)
show explicit 128 MiB segments and remote=false on all six topics. The
[current configs](../../docs/evidence/kafka-shared-production-release-20261109/topic-policy-after-release.json)
show only quarantines reverting those two values to defaults.

The [released quarantine writer](https://github.com/Asherlc/dofek/blob/6fe1d4fbd479cc1ed9be874538e2b7dc3c1b1551/src/metric-stream/redpanda-quarantine.ts)
calls legacy `alterConfigs` on every connection with only cleanup policy,
retention time and retention bytes. That API replaces the topic's override set;
omitted settings revert to defaults. This is the behavior documented by
[Kafka KIP-339](https://cwiki.apache.org/confluence/spaces/KAFKA/pages/87298616/KIP-339%2BCreate%2Ba%2Bnew%2BIncrementalAlterConfigs%2BAPI).
The writer file is unchanged from old application source `f02798b72`, so this
behavior was not introduced by the shared-image rollout. No exact earlier reset
time is asserted.

No topic mutation or workaround was executed after discovering the discrepancy.
The current retention byte/time limits and native erasure checks remain in
place. Nevertheless, **do not report the packet's all-six 128 MiB policy as
verified**, and do not activate tiering while startup can discard independently
configured remote-storage settings. Merely restoring the settings once would
not fix the next reconnect. The user subsequently approved the narrow
DescribeConfigs validation fix, now locally qualified in the
[correction proposal](quarantine-config-correction.md). Its production release
and topic correction have not been executed or authorized by that fix request.

## Retrospective and next step

Exact source/image checks and the canonical release gates worked. Checking the
real Docker env-file loader before merge caught the cluster-ID quoting defect;
checking actual topic configs after deployment caught a gap that successful
health, lag and identity checks do not cover. Future release qualification should
compare selected topic overrides **after clients connect/reconnect**, and check
workflow state before assuming CI will trigger a release. These are proposed
runbook improvements, not permission to change repository workflow settings.

Finish the quarantine configuration fix and reconcile the separate tiered PR
with main before its activation review. Keep the accepted late-PUT/orphan
exception, remote-backend/capacity qualification, retained-data retirement and
erasure-scrub combination gates explicit. None were waived by this release.
