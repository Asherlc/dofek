# History ClickHouse recovery — completed 2026-11-08 UTC

The user-approved history-only release deployed source `9a16c806fc0ebe587c5d4e6665ac888f87beefa2`
on the existing Redpanda broker. The consumer committed from offset
`70578630` through the unchanged high watermark `74445631`, advancing
**3,867,001 offsets** without an offset reset or manual acknowledgement.

Zero lag and healthy service/group state were observed at **04:50:20 UTC**
and confirmed at **04:55:18 UTC**. Other serving/archive groups were at zero
lag at both checks. The consumer remains running at one replica; the
recovery heartbeat was deleted after confirmation. Kafka cutover and old
broker-data deletion did not occur.

- [Summary](summary.json): release provenance, authorization, sampled health,
  rollback baseline, completion checks and limits.
- [Progress](progress.jsonl): sanitized operator snapshots during the drain.
  Each snapshot reports observations rather than continuous coverage.
- [Deletion-candidate identity proof](../metric-stream-deletion-scope-audit-20261108/summary.json).
- [Executable implementation verification](../metric-stream-identity-local-20261107/implementation-verification.json).

No credentials, event bodies or user identifiers are included. Source logs
and retained service state were inspected with stock Docker/`rpk` commands;
ClickHouse health and matching INSERT exceptions used system metadata.
An optional full-window query-text profile exceeded its 256 MiB operator
memory cap and was not retried; it is explicitly unavailable, not a consumer
failure or a claimed proof. The result establishes consumer catch-up and
observed health, not physical per-user erasure, independent per-event domain
receipts, archive replay safety or future workload performance.

Stock consumer-group inspection is documented by
[Redpanda](https://docs.redpanda.com/current/reference/rpk/rpk-group/rpk-group-describe/).
The release used Docker's standard
[service update](https://docs.docker.com/reference/cli/docker/service/update/)
and retained its standard
[rollback](https://docs.docker.com/reference/cli/docker/service/rollback/)
option; no monitoring framework or runtime retry/timeout workaround was added.
