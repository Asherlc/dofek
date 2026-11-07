# Sanitized evidence — `kafka-ts-dual512-20261106` (FAIL)

D2 local comparison: two topics × 256 × 512 KiB (= 256 MiB total user bytes).
Same Kafka **2048 MiB** cgroup / **1 GiB** heap as the small functional lab.
**Result: cgroup OOM during earliest remote consume.** No automatic limit raise.

Nonsecret artifacts only. Narrative + RCA:
[`docs/kafka-tiered-storage-assessment.md`](../../kafka-tiered-storage-assessment.md#november-6-d2-dual-512kib-lab-fail--rca).

## Verdict

| Stage | Result |
|---|---|
| Produce (stock size limits) | PASS |
| Remote tier + local closed removal | PASS |
| Earliest count/order/digest | **FAIL** — Exit **137**, `OOMKilled=true` |
| Broker restart + re-digest | NOT REACHED |
| Larger Kafka memory on current host | **UNQUALIFIED** |

## First fatal

```text
Command: docker exec …/kafka-console-consumer.sh --topic topicA --from-beginning --max-messages 256
Inspect: Status=exited Exit=137 OOM=true Finished=2026-11-06T21:57:40Z
Log:     21:57:37Z consumer group join → 21:57:40Z death; no java.lang.OutOfMemoryError in broker log
```

## Root cause (scoped)

Primary: digest client ran **inside** the broker cgroup via `docker exec` and
**inherited** `KAFKA_HEAP_OPTS=-Xmx1G -Xms1G` (console-consumer only defaults to
`-Xmx512M` when unset). Broker 1 GiB heap + client 1 GiB heap in a 2048 MiB
cgroup leaves essentially no headroom during heavy remote read.

See `RCA.json` for citations (Kafka 4.4 scripts, Aiven MemoryChunkCache, TS
index-cache docs), sampler gap, and the **one** proposed same-2 GiB retest
(client outside broker cgroup / pinned small client heap — no cgroup raise, no
silent RLM/fetch tuning).

## Workload delta vs ~5 MiB functional lab

| | Functional `kafka-ts-lab-20261106` | This D2 lab |
|---|---|---|
| User bytes | ~5 MiB (5000×1 KiB) | 256 MiB (2×256×512 KiB) |
| Earliest digest | PASS (peak sampled 809 MiB) | OOM at consume start |
| Claim | Functional only | **Not** Pulsar RAM A/B |

## Files

- `CORE_PROOF.json` / `CORE_PROOF.sha256` / `RCA.json`
- `kafka-death-inspect.txt`, `kafka-death-logs-tail.txt`
- `object-inventory-final.txt`, `local-segments-post-produce.txt`
- `size-and-segment-plan.json`, `cgroup-baseline.json`, `cgroup-sample-summary.json`
- produce / topic / cleanup timestamps
