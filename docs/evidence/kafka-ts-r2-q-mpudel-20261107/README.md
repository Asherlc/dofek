# Sanitized evidence — R2 Q-MPU attempt `20261107` (failed before runtime)

**Not a test pass/fail.** Create+mint succeeded; broker launch never started Docker.

| Field | Value |
|---|---|
| First fatal | `Error: spawnSync docker ENOENT` at `scripts/compose-command.ts` line 39 |
| Cause | Operator private-child launch PATH omitted `/usr/local/bin` (where `docker` lives) |
| Repo defect | **None** — stock wrapper; do not patch `compose-command.ts` for this |
| Containers | **0** |
| Object uploads / GET | **0** |
| Cleanup | ListObjects **0**, ListMPU **0**, DELETE **200**, GET **404** (`ROOT_FAILED_SETUP_CLEANUP.json`) |
| Child session | No revoke API; TTL expiry only; parent archive key **not** revoked |
| Retry | Fresh identity `kafka-ts-r2-q-mpudel-20261107b` — **do not recreate** this bucket |

Same Q11A budget carries to retry (≤16 MiB upload, **0** used).
