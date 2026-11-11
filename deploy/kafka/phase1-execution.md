# Kafka-only phase 1 execution — November 9, 2026 UTC

**Kafka-only phase 1 is live; the bounded observation passed.** The user approved
[the exact phase-1 bundle](phase1-approval.md) with “Y” (Q4/A). Tiered storage,
PR merges, shared application rollout, migrations and old-data retirement are
outside this operation. The [stock command record](operator-proposal.md) includes
the corrected stopped-broker mount sequence.

## Executed boundaries

- Private original specifications for twelve services, four original routing
  values and a forward/pre-write recovery plan were frozen before route changes.
  No credentials or event bodies are published in this receipt.
- Kafka 4.4.0 was prepared on `/mnt/dofek-data/kafka-broker/data` with the preserved
  cluster ID, canonical fifteen environment settings, remote storage disabled and
  no plugin mount. The abandoned Kafka and original Redpanda trees were preserved.
- Six topics were created with the approved 4-GiB source / 1-GiB quarantine,
  seven-day time ceiling, 128-MiB segments, one partition and RF1. All six had
  zero offsets before consumer start. Native topic generations were recorded.
- Web and worker exited with code 0 at 01:29 UTC. All six old consumer groups
  reached their final source boundaries; archive groups committed through those
  boundaries. Old quarantines remained empty. A three-second, read-only aggregate
  query found zero erasure requests. Actual old consumer and Redpanda task exit
  was checked before routing changes; old data remains allocated.
- Twelve stopped-service specifications were compared with their frozen originals.
  Only the approved routes, worker image/Node command/read-only mounts, replica
  counts and broker specification changed. Web, legacy/live sinks, repaired history
  and Connect retained their distinct image pins, secrets, configs and resources.
- Only the four approved existing Infisical routing keys were updated. Private
  readback verified equality without printing values.
- First-write authority was recorded at **01:32:22 UTC**, before starting consumers,
  conservatively including quarantine writes. From that boundary, the approved
  forward stop/preserve plan applies; zero sampled offsets do not permit RP cutback.
- All six new groups became Stable with one member and zero lag. Three sink
  readiness endpoints returned 200; all three archive input/output connections
  were ready. Web and the pinned local-only worker resumed at approximately
  01:34 UTC. Live Kafka records subsequently reached both downstream consumers.
- Worker mounts were verified readable and `RW=false` at the actual container:
  Kafka data and the original retained Redpanda root. Retained RP therefore still
  prevents final erasure completion; no retirement was performed.

## Preparation correction

An initial operator check wrongly expected eighteen environment keys. Comparing
with the checked-in canonical stanza corrected this to fifteen settings plus the
preserved `CLUSTER_ID`; no broker environment change was needed for that check.

The first stopped-broker update combined `--mount-rm /var/lib/kafka/data` with
`--mount-add` to that same target. Its effective specification had `Mounts: null`.
The verification then failed with `TypeError: Cannot read properties of undefined
(reading 'length')`. An outer operator shell without checked failure propagation
continued to a broker start. The isolated broker was promptly scaled back to zero.
No application endpoints had changed, no application topics had been created,
and the fresh persistent directory was still empty. All eleven old service
specifications matched their frozen originals.

The direct correction added the bind in a separate stopped-service update.
Explicit independent checks then verified Kafka zero/actual task exit, canonical
environment, preserved cluster, exact mount and unchanged old services before
the successful start. No storage was deleted or settings relaxed. See Docker's
[service update](https://docs.docker.com/reference/cli/docker/service/update/)
and [Swarm task states](https://docs.docker.com/engine/swarm/how-swarm-mode-works/swarm-task-states/).
Future operator commands must check prerequisite exit status before each mutation;
`set -e` inside an unpropagated subprocess is insufficient execution control.

Three old ClickHouse sink tasks exited 137 during their native stop, after final
source offsets were fully committed. No manual kill/reset/acknowledgement was
issued. The consumers restarted healthy with preserved images. Their stop
lifecycle is recorded as an operational limitation, not evidence of lost records.

## Observation and remaining work

The first sample at 01:35:05 UTC showed **43,682,246,656 B free**, Kafka allocated
24,465,408 B, all six groups stable/zero lag and zero archive output/connection
errors. The live archive had twelve successful outputs. Native source-log bytes,
filesystem allocation, free space and offsets are separate measurements; none
establish a historical peak or guaranteed replay duration.

The observation completed at **02:05:39 UTC**. An initial 01:35:05 sample plus
thirty scheduled minute checks span **1,834 seconds**. All six groups stayed
Stable with one member and zero observed lag; all ten application/broker/consumer
tasks stayed healthy with no restart. Archive output/connection errors remained
zero; live successful outputs advanced from twelve to twenty-six. No stop
condition fired. Minimum free space was **43,532,427,264 B (40.54 GiB)**, above
the approved 20-GiB reserve. Final free space was **43,608,772,608 B**.

Final Kafka filesystem allocation was **49,680,384 B**, while native source-log
bytes were **48,533,832 B**. Neither is an offset count or historical peak rate.
The [sanitized summary](../../docs/evidence/kafka-phase1-cutover-20261109/summary.json)
contains topic UUIDs, final source/quarantine offsets, all six old/new group
boundaries, exact image pins and task uptime. The
[observation samples](../../docs/evidence/kafka-phase1-cutover-20261109/observations.json)
retain every scheduled check. Quiet legacy/history topics received no records
during this window; their connections were healthy. No synthetic load was sent.

The public web endpoint returned HTTP 200 during observation. Bounded post-resume
log samples from web, worker and three sinks contained no KafkaJS error lines;
this is sampled instrumentation, not a claim of complete log-history inspection.
The final three-second read-only erasure aggregate remained zero. The bounded
operator watch has ended; it is not a new permanent monitoring service. The
approved stop/preserve guidance remains the operating boundary for later issues.

Later shared-application release and PR merge still require their own qualification
and authorization. Phase 2 must qualify tiering on these same cluster/topic
generations and offsets; it must not create replacement topics. Retained-data
retirement and coordinated six-field erasure scrub integration remain separate.

## Retrospective

Native group offsets, output counters, actual task health and pinned images
provided the required cutover evidence without a custom runtime controller.
Effective mount inspection and explicit outer-command failure propagation were
the preparation gaps; the stock operator record now makes those steps concrete.
For the next release, preserve this current-state receipt and reuse the existing
production-log and PR-review workflows. This window does not prove host/disk-loss
recovery or a complete archive restore.
