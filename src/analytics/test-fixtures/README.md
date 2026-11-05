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

The fitness native client exited successfully. The throwaway wrapper raced its
normal exit; checks were validated offline from the retained native
artifact. Its SHA-256 is
`2ca5343c7df0498cfead19f3d7476cd373245905056285eb7742dffa7554f0d7`.
The wrapper was not fixed or reused. These fixtures qualify source envelopes,
not destination types, raw writes, acknowledgements by the application, the
Pulsar erasure lifecycle or production capacity. See the
[qualification record](../../../docs/pulsar-qualification.md).
