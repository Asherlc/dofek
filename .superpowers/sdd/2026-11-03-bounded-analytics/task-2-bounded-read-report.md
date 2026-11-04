# Bounded journal proof and reference reads

**DONE_WITH_CONCERNS — scoped implementation verified, ready for independent review.**
BASE `177ad70a8`. Root's intervening `e19d5169e` changes only the local-PG
incident documentation. Source checkpoint:
`8848d6e84f5159d6c91bf555d83fa3c6cdb2799c` (three source/test files), committed
and PUSHCONFIRMED. Full Task2,
the original350/1001 performance gates, native ACK, erasure and host/resource
qualification remain incomplete. No root human documentation was staged.

## Change and boundaries

`effect-journal.ts` now loads the same three preflight proof sets for an existing
page of at most20 effect identities: committed manifests, discovery hashes and
prior journal hashes. Each key is checked independently against the original
closed-stage and immutable-hash rules before the existing phase writes. Public
append inputs larger than20 preflight **all** chunks before any append write;
duplicate input identities across chunks are rejected before querying/writing.

Receipt verification and discovery paging fetch the exact journal payloads for
the nonempty references in their existing at-most20-reference page together.
Each requested key must have exactly one payload. Ownership, body hash,
discovery hash and serialized native identity are verified through the same
decoder/checks. Reference order still determines the digest, counts and cursor;
empty references retain their ordinal/hash validation and require no payload.

Queries use complete native storage tuples with scalar typed parameters and
`FINAL`. Kafka offsets, Pulsar coordinates and ordinals stay strings/BigInts;
neither source UUID nor JS numeric conversion substitutes for storage identity.
`LIMIT 2 BY` the complete identity retains per-key ambiguity detection; there is
no global LIMIT that can hide the final requested identity. Returned identities
must be requested, response cardinality is at most2 per key, conflicting hash
rows reject, multiple manifests reject, and payload cardinality must be one.

All queries are sequential through the existing owner. There is no cached
witness, skipped phase observation, new store/schema/API option, production
UNION, optimizer setting, wider page, retry or deadline change. Complete intent
still precedes **any** raw mutation; all five prepared-intent traversals,
pre-commit verification and durable receipt verification before frontier/ACK
remain. This reduces request counts for multi-effect pages, not E=1 or
zero-effect deliveries. No elapsed-time or sustainable-throughput claim is made.

## Actual test-first evidence

Engine prefix (all runs used `--retry 0 --bail 1`, one private runner at a time):

```sh
rtk proxy pnpm tsx .superpowers/sdd/2026-11-03-bounded-analytics/run-database-tests.ts
```

| Path / filter | Log | Actual result |
| --- | --- | --- |
| `src/analytics/effect-journal.integration.test.ts -t twentyEffectPreflightUsesThreeBoundedProofReadsBeforeExistingWrites` | `bounded-proof-first-red.log` | RED1/21skipped:20 effects issued60 proof reads, expected3;3.62s. |
| Same focused test after proof batching | `bounded-proof-first-green.log` | GREEN1/21skipped; both fresh/replayed20-key calls use3 reads and preserve20 actual rows;4.15s. |
| Journal `-t twentyDiscoveryReferencesUseOneExactPayloadFetch` | `bounded-payload-first-red.log` | RED1/25skipped:20 payload queries, expected1;3.87s. |
| Journal `-t 'twentyEffectPreflightUsesThreeBoundedProofReadsBeforeExistingWrites\|twentyDiscoveryReferencesUseOneExactPayloadFetch\|publicAppendPreflightsAllChunksBeforeWritingWhenTwentyFirstIdentityConflicts\|proofLookupRejectsTamperedJournalHashAtPageEdge'` | `bounded-read-vertical-after-pg-budget.log` | GREEN5/33skipped;6.78s. |
| Full journal file at38-case checkpoint | `bounded-journal-covering.log` | GREEN38/38;26.98s. |
| Journal `-t 'duplicateIdentityAcrossChunks\|perKeyTwoRowBound'` (two subsequently added edge tests) | `bounded-read-extra-edges.log` | GREEN2/38skipped;3.66s. These and the preceding run exercise all40 current cases, not a claimed single40-case invocation. |
| `src/analytics/analytics-work-store.integration.test.ts src/metric-stream/clickhouse-sink-recovery.integration.test.ts` | `bounded-read-covering-workstore-recovery.log` | GREEN16/16 across two files;13.55s. |
| Provider `-t 'erasedPreparedTail\|erasedCommittedEvidence\|lostBatched'` | `bounded-read-provider-boundaries.log` | GREEN6/20skipped;13.52s. |
| `src/metric-stream/provider-generation-deletion.integration.test.ts -t '^(?!.*structural1001)'` | `bounded-read-provider-covering.log` | GREEN25/1skipped;41.07s. Includes prior19 and new6 cases; excludes only original1001. |

All completed GREEN runners exited0 and cleaned up their private fixtures.
No new resource fatal occurred after root corrected the local PG prerequisite.
The new corruption cases are covering regressions; the two request-amplification
tests above are the observed implementation-driving RED→GREEN checks.

Nineteen journal additions cover first/last hash mutations, missing first/last
payloads and closed-stage discovery identities, new closed-stage ordinal,
duplicate identities across chunks,21st-key conflict before any append,
mixed-stream/stage/native/Kafka keys above2^53, ownership/native-ID corruption,
actual duplicate/unexpected payload result rows, and a duplicate first key plus
conflicting last key. The last test delegates real SQL with duplicate rows
**before** the production `LIMIT 2 BY`; it would expose a global-LIMIT20 hiding
the21st returned row. Test-only real SQL UNION supplies corrupt result sets;
production has no UNION or fabricated response data/module mock.

Six coordinator additions remove actual persisted data at phase boundaries:
prepared-tail erasure causes zero raw writes; removal of each committed
manifest/discovery/journal set blocks typed ACK/frontier. Delegated real batched
proof/payload reads fully consume the server response then lose it at the client
boundary: no subsequent write/ACK, original nonterminal query ID/pending intent
retained, replacement blocked by Q7. Payload loss can occur after raw effects;
the assertion is zero writes **after** loss, not zero total raw effects.

## Native access-path evidence

The four existing40,000-history keyset fixtures now also exercise all four new
lookup shapes: payload, manifest, discovery hash and journal hash, for Pulsar
and Kafka with both one-delivery and many-delivery history. Each captured query
has exactly one actual QueryFinish profile, a primary-key EXPLAIN path, and
read_rows below the40k fixture history. Where the target table has multiple
granules, EXPLAIN must select fewer than all granules. The one-delivery manifest
table has only one manifest, so its pruning ratio is intentionally not asserted.
No projections or forced settings are used.

`bounded-journal-covering.log` retains exact query IDs/full EXPLAIN plans in
`[bounded-journal-lookup]` records. Across16 lookup profiles, observed read_rows
were51–13941 (granule/FINAL work, **not** a claim of20 physical reads). The
existing reader EXPLAIN/read-row checks also remain. These fixtures prove the
selected native access path prunes unrelated history; they do not establish a
whole-host byte bound, warm-soak qualification or production throughput.

## Local infrastructure interruption and final checks

The first five-case vertical attempt, `bounded-read-vertical-green.log`, failed
in beforeAll at2026-11-04T07:05:43.546Z with **“the database system is in recovery
mode”**,0HTTP/26skipped, runner33053 exit1. This is infrastructure failure, not
semantic RED. All DB commands stopped and root received the slot. Root proved
its own PG checkpointer SIG9 coincided with Docker OOM/cgroup oom_kill1, then
recreated only own PG on the same image/volume with its approved local1GiB
budget/shared256MB/maintenance64MB overlay. CH image/cap/lifecycle was untouched.
Root verified recovery=false/health and explicitly released one resumed run.
That exact selected vertical workload passed as recorded above.

The PG environment differs from earlier latency measurements. Do not attribute
later timing differences solely to this source change. Root owns incident docs,
runtime overlays and any further lifecycle; this implementation made none.

Final source checks:

```sh
rtk proxy pnpm typecheck
rtk proxy pnpm exec biome check src/analytics/effect-journal.ts src/analytics/effect-journal.integration.test.ts src/metric-stream/provider-generation-deletion.integration.test.ts
rtk proxy git diff --check
```

All exit0 (`bounded-read-typecheck-final.log`, `bounded-read-biome-final.log`; diff
check produced no output). Self-review compared each old per-effect check and
payload decoder predicate to its new per-key equivalent, checked all public
append preflight occurs before writes, and confirmed source changes are limited
to the two selected read loops/call sites. Existing lifecycle/owner source is
unchanged. No schema diagrams require regeneration because no schema changed.

## Remaining gates and retrospective

Root has the DB slot again; no350/1001 rerun occurred here. Their exact source
workloads,1000+1 command split,20-effect bound and30s deadlines remain unchanged
and OPEN pending independent review/post-change qualification. E=1 and
zero-effect costs remain. Task7's writer/erasure barrier and new-metadata
physical erasure remain mandatory: missing-evidence detection does not prevent
resurrection after a prior proof read. Native consumer/ACK, input privacy,
bootstrap/redrive and whole-host resource qualification are still open. This
checkpoint neither deploys nor restores any production hold.

The first20-key vertical slice made the request reduction directly observable;
real corruption and owned lost-response tests then checked that amortization
retains evidence. The PG OOM required root-owned diagnosis rather than retries.
Useful next-time guidance: record the private-runner/overlay ownership and
per-key versus global-limit requirement beside the integration runbook; use
database TDD and systematic debugging for similar query changes. This is a
proposed documentation improvement, not an unreviewed human-doc edit.
