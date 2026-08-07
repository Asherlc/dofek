# Scripts Agent Instructions

> **Read the [README.md](./README.md) first** for script purposes and usage.

## High-Level Mandates
- **Use `with-env.ts` for dev**: Always wrap dev commands (like `pnpm dev` or `pnpm seed`) in `pnpm tsx scripts/with-env.ts --` to ensure secrets from Infisical are available.
- **Idempotent Seeding**: `seed-dev-db.ts` is safe to run multiple times. It deletes its own seeded data (by provider ID) before re-inserting.
- **Reverse Engineering Docs**: When exploring new APIs or protocols, update the corresponding docs in `docs/` and add probe results to the exploration scripts.

## Common Tasks

### Seeding the DB
To get a fully functional dev environment with charts and data:
```bash
rtk pnpm tsx scripts/with-env.ts -- pnpm seed
```
The seed command applies migrations and verifies representative row counts before reporting success.

### Updating Schema Diagrams
After modifying files under `src/db/schema/`, run:
```bash
rtk pnpm tsx scripts/generate-schema-diagram.ts
```
Then commit the updated `docs/schema.dbml` and `docs/schema.puml`.

### Debugging WHOOP BLE
If you have a PacketLogger capture from iOS:
```bash
rtk pnpm tsx scripts/parse-whoop-ble-capture.ts capture.pklg
```
This will output `whoop_imu_data.csv` with decoded sensor samples.

## Guardrails
- **Production Access**: `make-admin.sh` requires SSH access to the production server. Use with caution.
