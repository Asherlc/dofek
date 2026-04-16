# Scripts Agent Instructions

> **Read the [README.md](./README.md) first** for script purposes and usage.

## High-Level Mandates
- **Use `with-env.sh` for dev**: Always wrap dev commands (like `pnpm dev` or `pnpm seed`) in `./scripts/with-env.sh` to ensure secrets from Infisical are available.
- **Idempotent Seeding**: `seed-dev-db.ts` is safe to run multiple times. It deletes its own seeded data (by provider ID) before re-inserting.
- **Reverse Engineering Docs**: When exploring new APIs or protocols, update the corresponding docs in `docs/` and add probe results to the exploration scripts.

## Common Tasks

### Seeding the DB
To get a fully functional dev environment with charts and data:
```bash
./scripts/with-env.sh pnpm seed
```
This will also refresh materialized views, so the dashboard shows data immediately.

### Updating Schema Diagrams
After modifying `src/db/schema.ts`, run:
```bash
pnpm tsx scripts/generate-schema-diagram.ts
```
Then commit the updated `docs/schema.dbml` and `docs/schema.puml`.

### Debugging WHOOP BLE
If you have a PacketLogger capture from iOS:
```bash
pnpm tsx scripts/parse-whoop-ble-capture.ts capture.pklg
```
This will output `whoop_imu_data.csv` with decoded sensor samples.

## Guardrails
- **Production Access**: `make-admin.sh` requires SSH access to the production server. Use with caution.
- **Migration Views**: The `seed` script recreates materialized views by dropping them `CASCADE`. Ensure no manual views have been added to the `fitness` schema that might be lost.
