# Kafka tiered-storage dual-512 fixture-correct retest (2026-11-06)

## Result: **PASS**

Same 2 GiB broker / 1 GiB heap / Seaweed 1 GiB / D2 plugin+RLM+fetch settings as the
confounded dual512 lab. Workload unchanged: 2 topics × 256 × 512 KiB = 256 MiB,
closed multi-part-eligible remote segments, local removal, earliest remote
count/order/hash, broker restart, re-hash match.

### Correction (plain)

The prior dual512 **FAIL** (Exit 137) was a **test violation**, not a Kafka
resource finding: `kafka-console-consumer` ran via `docker exec` **inside** the
broker cgroup and inherited `KAFKA_HEAP_OPTS=-Xmx1G -Xms1G`, putting a second
1 GiB JVM beside the broker inside the 2048 MiB cgroup. Root already required a
separate ≤384 MiB tool for admin/producer/consumer.

This retest placed **all** admin/producer/consumer JVMs in a separate `client`
service (`mem_limit: 384m`) with explicit `KAFKA_HEAP_OPTS=-Xms32m -Xmx256m`.
Broker process list asserted a single `kafka.Kafka` (healthcheck `TopicCommand`
disabled so it could not spawn a 1 GiB JVM in the broker cgroup).

### Digest provenance

- First `hash-a.json` was corrupted by `python3 … | tee hash-a.json` (progress
  mixed into JSON). Preserved as `hash-a.malformed.raw`. **Not** used.
- No stdout bytes were retained from that run, so observed digests were **not**
  reconstructed from the printed SHA.
- Fresh consumes wrote raw bytes to `consume-{topic}-a-fresh.stdout` /
  `consume-{topic}-b.stdout`; `hash-a.json` / `hash-b.json` written only via
  `pathlib` (never tee to the same path). Grammar: `^Offset:(\d+)\|(.*)$`.
- `sha256_stdout_bytes` in the hash files match the on-disk stdout files.

### Core assertions

| Check | Result |
|---|---|
| Local closed segments removed before digest | PASS (only `…00256.log` active) |
| Earliest count/order/digest A | PASS (256/256 contiguous each topic) |
| Broker restart + digest B match A | PASS |
| Broker cgroup OOM | **none** (oom=0) |
| Client outside broker; heap 256 MiB | PASS (process cmdline captured) |

### Lifetime cgroup peaks (MiB)

| Role | Peak | oom |
|---|---:|---:|
| kafka (2048 limit) | 1628.5 | 0 |
| seaweed (1024) | 808.1 | 0 |
| client (384) | 195.8 | 0 |

Kafka peak is dominated by produce/tier; digest-phase peaks ~1260 MiB with
client isolated.

### Artifacts

- `CORE_PROOF.json` / `CORE_PROOF.sha256`
- `hash-a.json`, `hash-b.json`, `hash-a.malformed.raw`, `hash-a-corruption-note.txt`
- `consume-topic{A,B}-a-fresh.stdout`, `consume-topic{A,B}-b.stdout` (+ stderr)
- `cgroup-sample.tsv`, `cgroup-lifetime-summary.json`, phase snapshots
- `object-inventory-prehash.txt`, `object-inventory-final.txt`
- `fixture-correction.json`, `broker-jvm-*.txt`, `client-jvm-during-*.txt`
- Ephemeral compose was under `/tmp/kafka-ts-dual512-fix-20261106/` (owned cleanup)

### Non-claims

- Does not re-litigate the confounded FAIL as a broker memory ceiling.
- No knob tuning; no RAM raise; no source patch.
