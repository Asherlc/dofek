# Kafka retention and shutdown observations

These are dated operator observations for the November 12, 2026 work
(continuing November 13 UTC), not instructions to repeat a recovery or a
complete disaster-restore qualification. The canonical
[server job](https://github.com/Asherlc/dofek/actions/runs/43330045743/job/131572442558)
passed on source `c7909fdafb0ad868407c9de493e3bd4e72f83b51`.
Trailing whitespace in retained text output was normalized for Git.

- [Pre-policy snapshot](pre-policy-baseline.json): the recorded allocation,
  offsets and collector counters before reconciliation.
- [Initial production observation](production-initial-observation.json): an
  explicit transcription of the first native readback, disk and group outputs.
  It preserves the numbers in the narrative; exact per-command timestamps were
  not retained. It is an operator record, not an original raw command log.
- [Original topic readback](production-topics-before.txt) preserves the six
  topic IDs before rollout (internal-topic lines omitted).
- [Topic readback after rollout](production-topics-after.txt), [global offsets](production-offsets-global.txt),
  [local offsets](production-offsets-local.txt) and [allocation](production-allocation-after.txt):
  timestamped raw follow-up outputs, captured later than the initial observation.
  Values can advance as ingestion and local retention continue.
- [Live remote read](remote-read-live.txt) and [history remote read](remote-read-history.txt):
  fresh native consumers requested the listed partition-zero offsets with
  automatic commits disabled and payload printing disabled. The requested
  offsets precede the local earliest offsets in the accompanying readback.
- [Owner recovery notes](owner-recovery-notes.md): the contemporaneous operator
  record of executor checks, exact conditional update, matching replay and
  restoration limits. This is a manually maintained execution note, not a
  database audit export; do not treat it as a replay procedure.
  The notes end at the earlier recovery phase, before normal background
  restoration and the successful canonical release; the
  [incident narrative](../../production-incident-baseline.md#exact-owner-recovery-and-successful-kafka-release)
  records those subsequent events.
- [Redis regression report](analytics-cleanup-worker-report.md): original-source
  RED and corrected-source GREEN commands, native natural-exit result and scope.
  The original source for RED was `ed978d6b9b013d117d37643695e853f108bf5d2f`;
  the report's historical `HEAD` references refer to that pre-cleanup version.
- [Full unit/mobile summary](unit-mobile-summary.txt): the successful local
  rerun after correcting transitive test mocks. CI remains the merge gate.

Operator Kafka tools ran in disposable containers outside the broker cgroup,
using the production-pinned Kafka 4.4.0 image. The read-only commands were
`kafka-topics.sh --describe`, `kafka-get-offsets.sh --time earliest` and
`--time earliest-local`, and `kafka-console-consumer.sh --partition 0
--offset <listed-offset> --max-messages 1 --timeout-ms 30000
--command-property enable.auto.commit=false --formatter-property print.value=false
--formatter-property print.offset=true`. Disk measurements used `du -sB1` and
`df -B1`. See stock [Kafka operations](https://kafka.apache.org/44/operations/basic-kafka-operations/)
and [tiered reads](https://kafka.apache.org/44/operations/tiered-storage/).

No health payloads, credentials, environment exports or standalone publisher
stdin were included. Transport acceptance does not establish Axiom metrics
query readback, which the existing token could not perform. Native remote reads
do not establish RF1 disk-loss recovery or full JSONL archive restoration.

## Shutdown follow-up release

The [server follow-up](https://github.com/Asherlc/dofek/actions/runs/43349572540/job/131637412851)
passed on `6ddbac5a32942167b9573712fb30fcf15194de0c` at November 13
02:58:31 UTC. These later read-only receipts retain their observation times:

- [Outgoing analytics stop](followup-analytics-stop.txt): Docker's unchanged
  grace deadline stopped the older process; no manual signal was used.
- [Restored services and allocation](followup-production-after.txt): selected
  image/replica/health fields, broker continuity, disk allocation and free space.
- [Analytics readiness](followup-analytics-health.json): a completed first cycle,
  HTTP 200, status `ok` and no recorded failure.
- [Consumer progress and backlog](followup-groups.txt): advancing commits,
  remaining sink lag and zero lag for both nonempty source archive groups.
- [Collector transport](followup-collector.txt): accepted/exported metric points
  and receiver failures/refusals; stored metrics queries remain unqualified.

The [matching signed archive](https://github.com/Asherlc/dofek/actions/runs/43349572540/job/131637457790)
passed cold package resolution and archive/package/upload. Its full diagnostics
remain in GitHub's masked log channel; raw signed-build log files or result
bundles are not copied into this packet. The original failed fetch cause remains
unknown. Matching TestFlight and OTA publication subsequently passed, and the
complete canonical release succeeded. See the [incident conclusion](../../production-incident-baseline.md#november-13-utc-shutdown-follow-up-deployed-and-cold-archive-qualified).
