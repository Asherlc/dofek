# Phase 1: deploy Kafka before tiered storage

**Concrete approval proposal; not executed.** The user explicitly chose Kafka
first, then tiered storage as a separate release. This supersedes the earlier
requirement for tiering at first activation. PR #3233 is phase 1; PR #3236 remains
stacked on it for phase 2. No full-child retarget/combined landing is needed.

## Current readiness evidence

[Read-only production preflight](../../docs/evidence/kafka-phase1-readiness-20261109/summary.json)
at 00:49–00:53 UTC on November 9 (group capture 00:53:05 UTC) found:

- Redpanda 1/1, Kafka 0/0, web 2/2, worker 1/1; application, repaired history and
  Connect image pins/route contracts match the prior qualification.
- All six ClickHouse/archive consumer groups Stable, one member each, zero lag.
  These positions are a readiness snapshot; final drain/archival checks repeat
  after the authorized writer pause. No event/archive bodies were read.
- Filesystem free **43,235,651,584 B (40.27 GiB)**. The original Redpanda tree
  already occupies **31,533,346,816 B (29.37 GiB)** within used space; do not subtract
  it from free space again. Aborted Kafka uses 909,312 B and is preserved too.
  The intended fresh Kafka directory does not exist yet.
- Memory available about 14.49 GiB; no active/queued deployment or Terraform run
  was observed. Recheck overlap at execution, not from this dated observation.
- Zero erasure requests, including zero incomplete or overdue requests, under
  a three-second read-only DB timeout. Recheck during the pause.
- Existing Redpanda byte counters are available, but retained peak/backfill rate
  history was not established. Current counters, offsets and retained log size
  cannot prove a replay duration. No synthetic load or long observation loop ran.

The pinned phase-1 worker is
`ghcr.io/asherlc/dofek@sha256:a498aaa503db452480fdd43a71cc8799aa2564eea30a070e0296a08effc48620`,
source `cd9c4eb28d186a2fab9af2ac2e91864c32f38477`. Compared with green parent
`eba115371`, its native-storage/runtime/phase-runner/scrub code is identical;
the drain difference is type-only. The existing [packaged phase proof](worker-image-proof.json)
therefore remains applicable. This does not qualify an unrelated later shared
application image. Broker is the already pinned stock Kafka 4.4.0 digest in the
[live PR #3233 operator commands](https://github.com/Asherlc/dofek/blob/kafka-broker-migration/deploy/kafka/operator-proposal.md),
with tiering disabled for this phase. These parent-branch files are live commands;
similarly named child-branch files are historical redirects and are not used.

## Proposed exact policy

| Topic class | Global time ceiling | Bytes per one-partition topic | Segment size |
|---|---:|---:|---:|
| Three source topics | 604,800,000 ms (7 days) | **4,294,967,296 B (4 GiB)** each | **134,217,728 B (128 MiB)** |
| Three quarantine topics | 604,800,000 ms (7 days) | Existing **1,073,741,824 B (1 GiB)** each | **134,217,728 B (128 MiB)** |

This proposes **15 GiB nominal topic retention**, plus active segments, indexes,
metadata, native retention-check/file-delete delay and concurrent database/host
growth. Six active 128-MiB segments are a further useful 0.75-GiB allowance,
not a complete overshoot bound. The observed free space leaves roughly 24.5 GiB
after those nominal allowances. It is not a reservation or hard quota.

The 128-MiB size matches the observed Redpanda segment size. Keep stock Kafka
cleanup/delete timing; do not add runtime retries, delay settings or quota code.
Byte retention can shorten coverage below seven days; **no number of replay
hours is promised**. RF1 retains the existing only-disk failure exposure. JSONL
archive delivery remains enabled, but unshipped archive replay is not claimed as
tested recovery. See [Kafka retention configuration](https://kafka.apache.org/44/configuration/topic-configs/)
and the [archive runbook](../../docs/metric-stream-redpanda-r2-runbook.md#replay).

## One proposed production operation

Approval must cover the policy above and the following ordered scope together:

1. Coordinate a release window without overlapping application/infra deployment.
   Freeze private original service templates and existing route values. Prepare
   Kafka alone on the fresh directory with remote storage disabled, while old
   applications continue on Redpanda. Preserve both old trees and managed R2.
2. Create the three proposed fresh source names from the [PR #3233 cutover packet](https://github.com/Asherlc/dofek/blob/kafka-broker-migration/deploy/kafka/cutover-packet.md)
   and their quarantine topics, one partition/RF1, with the exact policy above.
   Record native generations; fail on an unexpected existing identity.
3. Pause web/worker and all ingest/backfill writers, allowing the existing worker
   graceful-stop contract to finish active jobs. This includes application
   unavailability during the pause; no zero-downtime claim is made. Recheck zero
   old erasure requests, drain all six groups to their final old boundaries and
   verify archive acknowledgements. Then stop old consumers and Redpanda and
   verify actual task exit.
4. Bind the fresh routes to each existing image's actual broker key. Keep web,
   old/live sinks, repaired history and Connect separately pinned. Only worker
   changes to the qualified phase-1 image with native Kafka and original-RP
   read-only mounts. Use the stock commands in the operator proposal; no full
   stack, Terraform apply or migration belongs in this broker-only operation.
   This approval scope includes upserting **only four existing production routing
   keys**: `REDPANDA_BROKERS`, `METRIC_STREAM_LEGACY_TOPIC`,
   `METRIC_STREAM_LIVE_TOPIC`, `METRIC_STREAM_HISTORY_TOPIC`. All four were verified
   present by name using the pinned Infisical CLI, without printing values. Capture
   their old values privately; set the new broker endpoint/fresh names while
   writers are stopped, verify private equality/name presence, and restore them
   from that snapshot on a pre-write rollback. Redirect both update streams to
   a private log. No credentials, cluster ID, other keys or secret configuration
   change is included. Convergence must finish before any normal release.
5. Approve first writes only after the frozen recovery plan and readiness checks.
   Consumer quarantine publication also counts: the proof covers all six new
   source/quarantine topics and every possible writer, not just web/worker.
   Start consumers, then resume reviewed writers under that authority.
6. Observe **30 minutes, at 60-second checks**, using existing stock service/task,
   broker byte/lag, archive acknowledgement and filesystem metrics. The executing
   Kafka operator owns monitoring and immediate stop/preserve actions. No custom
   runtime quota, monitoring service or unbounded observation is introduced.

**Stop threshold:** at or below **21,474,836,480 B free (20 GiB)**, stop ingest/
backfill producers and web/worker writes; keep healthy Kafka consumers/archive
outputs draining. Also stop writers for a failing sink/archive/broker, unknown
acknowledgement state, or backlog growing over two consecutive observations.
Do not stop healthy consumers merely because producers are stopped. Inspect the
first fatal evidence and preserve both logs; do not truncate/delete storage or
raise limits to continue. Database/shared growth counts against the same reserve.
Missing observations or an unhealthy downstream leaves writers stopped.

## Recovery and old-data boundary, approved before first writes

Before any new application write, rollback may restore the saved old specs/routes
only after proving all six source/quarantine topics remain empty and every writer
has stopped. Restore original replicas, verify old routes and actual tasks, then
reopen ingress. Native internal/group metadata writes are distinct.

After a Kafka application write, Kafka remains authoritative. Stop producers,
preserve both Kafka and Redpanda logs, and keep healthy consumers draining.
The approved forward scope is restoring the same pinned Kafka/worker configuration
against its preserved data and verifying acknowledged offsets/downstream progress
before resuming. Lost/corrupt data, unknown write history or a recovery requiring
new capacity/schema/replay leaves writes stopped for the incident owner; no
unproven archive replay, offset reset, manual acknowledgement or Redpanda cutback.
The executing operator owns immediate stop/preserve; the user/coordinator owns
escalation beyond that frozen restoration scope.

Original RP data stays in place and blocks final erasure completion while retained.
No requests are pending now; future requests may wait until separately approved
retirement. Approval must accept that hold/deadline implication, not authorize
deletion implicitly. Aborted Kafka remains untouched with its existing no-app-write
provenance. No other erasure guarantees are relaxed.

## Merge and phase 2

Normal automatic deployment requires Kafka already active. After stable phase 1,
merge PR #3233 only when the following shared application release is qualified
and authorized: it replaces multiple images, restores canonical worker entrypoint,
uses converged routes and performs its own Terraform/schema preflight. Green
broker CI and the pinned narrow worker do not alone qualify that broader release.

Tiered storage is a **later, separately approved release** through PR #3236,
preserving the same Kafka data, cluster/topic UUIDs, offsets and archive identities.
It must qualify stock online topic enablement/broker restart and switch the worker
to its separately qualified tiered verifier coherently. It is not a prerequisite
for phase 1 and must not create a second topic generation to enable tiering.
