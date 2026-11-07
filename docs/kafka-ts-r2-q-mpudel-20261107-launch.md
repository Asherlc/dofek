# Root launch packet — R2 Q-MPU+Q-DEL (`20261107b` retry)

**Same Q11A approval** (no new user ACK). Prior `20261107` attempt: mint OK,
broker up **ENOENT** (operator PATH missing `/usr/local/bin`); cloud cleaned;
**do not recreate** `kafka-ts-r2-q-mpudel-20261107`.

Frozen lab: `/tmp/kafka-ts-r2-q-mpudel-20261107b/`
Authoritative argv/hashes: `ROOT_LAUNCH_ARGV.json` there.

## Exact identity (retry)

- Bucket: `kafka-ts-r2-q-mpudel-20261107b`
- Prefix: `kafka-ts-parity/r2/20261107b-q-mpudel/`
- Account: `8e5b2f62ffe8ebdd48e725d325a6d51e`
- TTL: 3600; wall ≤55 min after mint; upload ≤16 MiB (**0** consumed on failed attempt)
- Project suffix: `kafka-ts-r2-q-mpudel-b`

## Operator PATH (mandatory)

Include `/usr/local/bin` (and usual mise/pnpm bins) so
`spawnSync("docker", …)` in stock `scripts/compose-command.ts` succeeds.
First-attempt fatal: `Error: spawnSync docker ENOENT`. **Not** a repo patch.

## Credentials / mint hygiene

Same Phase F path: Bearer + `R2_ACCESS_KEY_ID` parent ID; capture mint JSON in
private memory; return names-only to Cursor. Child →
`KAFKA_TS_R2_CHILD_*`. Parent never broker. No child revoke API; do not revoke
prod archive parent.

## Broker up argv

See `/tmp/kafka-ts-r2-q-mpudel-20261107b/ROOT_LAUNCH_ARGV.json`.
