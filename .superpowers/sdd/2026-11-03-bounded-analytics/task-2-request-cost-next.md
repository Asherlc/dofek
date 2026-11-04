# Next request-cost reduction — read-only assessment

**Recommendation:** first amortize the existing per-effect proof reads over the
existing at-most20-effect page; then fetch the journal payloads for an existing
at-most20-reference discovery page together. Keep the same proofs, writes,
five prepared-intent traversals and per-delivery lifecycle. Do not use a cached
fresh-write/committed witness to bypass persisted replay/completion verification.
No implementation, database query, runtime, lifecycle or source edit occurred
in this assessment. Source examined: `c75b77dba`, report checkpoint `b3eb4624c`.

## Evidence and scope

Root's attributed40-delivery pair:

| Measurement | Elapsed | CH calls | PG calls | Visible rows |
| --- | ---: | ---: | ---: | ---: |
| `sink-roundtrip-pg-baseline.json` | 13880.67ms | 1400 | 6479 | 40 |
| `sink-roundtrip-pg-after-registration.json` | 14206.39ms | 1400 | 3679 | 40 |

The2800-PG reduction is measured; elapsed improvement is not. One pair establishes
neither regression nor sustainable throughput. Broker/source/native ACK and
whole-host qualification are excluded. Both unchanged350-delete and1001-source
30s gates remain OPEN after their single post-review runs; no further run here.
Root attributes the1001 timeout's3275HTTP to actual deletion work, not its bulk seed.

The original source count still applies: ordinary scalar1-effect delivery has
**35 CH calls,9 manifest reads,5 prepared traversals**. The current hot loops are
[`persistAnalyticsEffectPage`](../../../src/analytics/effect-journal.ts:194)
(three CH reads for each effect, then existing batched writes), and
[`verifyAnalyticsDeliveryReceipt`](../../../src/analytics/effect-journal.ts:599)
(one payload request for each reference despite reference pages of20).

## Smallest next source changes

1. **Bounded per-page identity proof lookup.** For at most20 input effect
   identities, read the committed manifest(s), discovery hashes and prior journal
   hashes with three bounded native queries instead of3E queries. In the source
   prepare/commit path all identities belong to the same delivery; its manifest
   needs one lookup for that page, not one per effect. Apply the existing checks
   to *every* input identity before the existing phase writes. No proof survives
   into another phase as authority to skip its reads. Public append semantics
   must retain all guards-before-its-write behavior; batching reads must not
   accidentally publish an early prefix before detecting a later conflict.
2. **Bounded reference payload lookup.** Replace the per-reference calls to
   [`readReferencedEffect`](../../../src/analytics/effect-journal.ts:566) with
   one exact-key fetch for the nonempty members of each existing reference page.
   Validate every requested payload independently, then restore reference order
   for counts/digest/cursors. Explicit empty references require their own current
   validation and no invented payload. Apply the helper to receipt verification;
   reuse in discovery paging only with its existing20-plus-lookahead semantics.

Use full storage identity: epoch/topic/partition/transport plus lossless native
or Kafka coordinates, ordinal and stage. Preserve serialized native identity
checks in the existing manifest/decoder path. Never deduplicate by source UUID
or sensor key, coerce UInt64 coordinates to JS numbers, choose the last map row,
or treat query failure as absent metadata. Returned keys must be requested,
unique/consistent and individually accounted for. Retain per-key ambiguity
detection (current point readers allow at most2 rows to detect conflict), with
a bounded overflow guard; a global LIMIT must not silently hide another key.

Exact-key tuple filtering is a native option documented by ClickHouse's
[IN operator](https://clickhouse.com/docs/reference/statements/in). Types must
match exactly; actual26.10 FINAL/EXPLAIN/read-row tests over unrelated history
are required. This assessment has not verified the candidate query plans.
No projection, forced optimizer, global setting, extra store or wider limit is
proposed. Cardinality bounds do not establish a byte/host-memory budget.

Static request arithmetic only: source prepare+commit's identity checks change
from6E to6P reads, where P is the existing20-effect page count. For1000+1 effects
in two commands, E=1001/P=51 gives6006→306 reads in those two loops alone. One
1000-effect receipt verification changes its1000 payload requests to50; the
manifest and51 discovery-page reads remain, giving1052→102 reads for that
verification. Provider ACKs may invoke verification repeatedly; no invocation
is omitted. These are not measured elapsed savings or a promised30s pass.

For E=1 both amortizations save **zero** calls: ordinary35-CH cost remains.
Zero-effect delete messages also receive no benefit from per-effect batching;
this does not resolve the350-message gate by itself. If measurement then points
to these cases, a separate small candidate is a tagged, bounded `UNION ALL` of
the same-phase manifest/hash proof branches: replacing3→1 requests in both
persist phases would statically change35→31 for a fresh1-effect scalar. Preserve
all guards and explicit missing/error states. ClickHouse can mix/execute UNION
branches concurrently, so tags/types/order and per-branch limits require actual
tests; it is not a cross-table transaction or erasure barrier. See
[UNION semantics](https://clickhouse.com/docs/reference/statements/select/union).
Do not start by removing later manifest reads or traversals to improve this count.

## What each existing observation protects

For the fresh1-effect path, manifest observations are1 coordinator committed
probe +2 preparation admission +1 preparation-persist +1 pre-raw verification
+2 pre-commit verification/committed comparison +1 commit-persist +1 completion
=9. The five traversals are post-prepare persisted fingerprint, pre-raw full
verification, raw application, pre-commit full verification, discovery commit.

| Read/proof retained | Existing executable coverage | Required targeted regression for the proposed read-set refactor |
| --- | --- | --- |
| Admission/closed-stage manifests and per-key discovery/journal hashes | `partialIntentCannotBeMistakenForCompleteAndReplayPreservesPrefix`; `laterDeliveryCannotEnterAnAlreadySealedPrefix`; `replaysDuplicateDeliveryWithoutMissingEffects` | A changed hash at first/20th key and a new ordinal in a closed stage reject the whole page before writes; one missing required closed-stage receipt must not become a fresh key. Open-stage first-write absence remains valid. |
| Exact journal body/ownership/native identity, consecutive ordinals, full count/digest | `preparedIntentIsImmutableAndUndiscoverableUntilRawSuccess`; `scopeSizedIntentUsesBoundedPagesAndStreamedReceiptFinalization`; transport coexistence/restart test | Remove/tamper the last prepared payload after its manifest but before first raw write: zero raw mutations. Cover owner/version/hash/serialized-ID corruption and lossless Kafka/native keys above2^53. |
| Explicit zero-effect preparation and empty reference identity | `zeroEffectIntentNeedsExplicitCompletePreparation`; `zeroEffectReceiptAdvancesANoncollidingDurableCursor`; `emptyButNotExhaustedPagesAdvanceThroughBoundedReceiptSpans` | Mixed empty/nonempty references preserve counts/order/cursor; malformed empty ordinal/hash fails; no payload lookup or fake effect for an empty marker. |
| One exact payload per nonempty reference, receipt owner/hash agreement, ordered digest | `missingAllEffectsOfAnEarlierReceiptedDeliveryCannotBecomeExhausted`; `cannotSealPastIncompleteReceipt`; `limitsEffectsBeforeDistinctKeys`; `largeEffectOrdinalsRoundTripWithoutNumericTruncation` | Among20 references, remove/corrupt only first or last payload, introduce a wrong-stage/transport key or unexpected row: fail, never return19 valid effects or collapse repeated source UUIDs. |
| Complete durable receipt before frontier/broker ACK, including replay | `journalFailureAfterRawWritePreventsFrontierAndReplayRetainsIntent` (both insert boundaries); `completedReceiptRepairsFrontierGapBeforeAnyNewRawMutation`; `completedBatchedSiblingCanReplayWhileLaterIntentIsPending`; `markerCannotOutrunPriorEffects` | Delete committed manifest/discovery/payload after commit response but before frontier completion: no frontier/broker ACK. Typed/marker proof readers must still validate exact durable receipt; do not reuse an earlier fresh witness. |
| Unknown query outcomes remain blocked | Current19 owner cases, especially caught unknown late-write continuation/return and lost committed registration response | Actual delegated proof-read/payload-read response is lost: no absent-row fallback, no subsequent write/ACK, original query ID/pending intent retained and replacement blocked. Fully consume every result through the same owner. |

Names above are in `effect-journal.integration.test.ts`,
`analytics-work-store.integration.test.ts`,
`clickhouse-sink-recovery.integration.test.ts` and
`analytics-query-owner.integration.test.ts`. They cover the named existing
behaviors; the new per-key/mid-phase corruption cases are **requirements**, not
claims that those exact injections already pass.

## Fresh writes, erasure and remaining limits

A fresh successful INSERT is terminal request evidence, not proof that its
metadata remains present. Partial preparation may exist without a manifest;
resume must read actual prior identities and freeze the original preimage.
The entire prepared intent must still be verified before *any* raw mutation;
streaming raw while computing its eventual digest would weaken that boundary.
Post-raw pre-commit validation and exact receipt verification must remain too.

An erasure actor can remove journal/receipts outside this global source owner.
The known-account-fence test (`activeAccountFenceAndGenerationAndNewerDeleteScopeHaveDurableDispositions`)
and provider USERLESS cancellation test cover the fence already present before
preparation; they do not prove concurrent new-metadata erasure safety. Add actual
deletion between prepare/verification/raw/commit/frontier boundaries to prove
that retained readers still detect missing evidence. The writer/erasure barrier
and prevention of metadata resurrection after a proof read remain mandatory
Task7 work, not an assumption allowing cached witnesses. These refactors cannot
claim to implement that barrier or qualify physical erasure.

Proceed only after root selects the scoped read-set change, with real-engine
per-key corruption/identity and native plan tests, owner/recovery suites and
one attributed post-change measurement. Both large workloads stay unchanged;
run them only when root schedules a changed-code validation, never retry to green.

Retrospective: PG exchange reduction alone did not lower elapsed time in the
finite pair. The next useful distinction is page-amortizable identity/reference
reads versus phase-boundary verification. Keep that distinction in the review
checklist; reuse executable-database TDD and systematic-debugging rather than
introducing a second execution lifecycle.
