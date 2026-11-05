# Native CDC fixtures

These captures contain synthetic qualification data only; no production health
data or credentials. JSON lines retain the original native message ID, topic,
key, enumerable properties and base64 payload bytes.

- `cdc-source-transactions.ndjson`: 347 retained source-spike messages for
  transaction ordering, ordinal accounting and source republication.
- `cdc-fitness-envelopes.ndjson`: 42 messages from pinned Debezium 3.7.0.Final,
  Pulsar 5.0.1 and a fresh canonical PostgreSQL 18.3 fixture. It covers eight
  snapshot rows across seven tables and three transactions. Replica identity
  was FULL. Activity changes include microsecond timestamps, JSON arrays/nulls,
  unchanged external text, deletion and a primary-key split. Priority changes
  include synthetic bigint 2147483648. Markers are append-only: parent deletion
  cascades to the original marker, followed by a new marker under another
  synthetic operation.
- `cdc-fitness-parent-envelopes.ndjson`: 48 additional messages from the same
  pinned engines and a fresh canonical database. Eleven snapshot rows cover
  the seven tables plus `processing_operation`, projected by the stock column
  include list to `id,user_id` only. The parent has owned and explicit NULL-owner
  snapshot rows. Its delete before-image retains the former owner and shares
  raw transaction 848 with the marker cascade; END, ordinal and collection
  accounting pass for that transaction. The native client and wrapper both
  exited zero, and disposable cleanup passed. SHA-256:
  `e5192845e0ff3eeda0cac357ec03fc3dc0f8c39d266c37e305a1a4d90d4d07a4`.

The original seven-table fitness native client exited successfully. Its throwaway wrapper raced its
normal exit; checks were validated offline from the retained native
artifact. Its SHA-256 is
`2ca5343c7df0498cfead19f3d7476cd373245905056285eb7742dffa7554f0d7`.
The wrapper was not fixed or reused. These fixtures qualify source envelopes,
not destination types, raw writes, acknowledgements by the application, the
Pulsar erasure lifecycle or production capacity. See the
[qualification record](../../../docs/pulsar-qualification.md).
