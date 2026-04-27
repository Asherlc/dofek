# Offline CSV Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build offline CSV data exports that are tracked in Postgres, uploaded to user-scoped R2 prefixes, emailed through Brevo, and listed in web/mobile settings.

**Architecture:** `fitness.data_export` stores export state and ownership. `POST /api/export` creates a record and queues a BullMQ job; the worker generates a CSV ZIP, uploads it to R2, marks status, and emails a signed link. Clients query `GET /api/export` for active and completed user exports and request downloads through the server.

**Tech Stack:** TypeScript, Drizzle schema + manual SQL migration, BullMQ, Cloudflare R2 through AWS SDK S3 client, Nodemailer SMTP, Express REST routes, React, React Native, Vitest.

---

### Task 1: Export Records Schema

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/0003_data_exports.sql`
- Test: `packages/server/src/routes/export.test.ts`

- [ ] **Step 1: Write failing route tests for DB-backed listing and creation**

Add tests that expect `POST /api/export` to insert an export record and enqueue `{ userId, exportId, outputPath }`, and `GET /api/export` to return only the authenticated user's active and completed unexpired records.

- [ ] **Step 2: Run route tests to verify failure**

Run: `pnpm vitest run packages/server/src/routes/export.test.ts`

Expected: failures because `GET /api/export` does not exist and `POST /api/export` does not create an export record.

- [ ] **Step 3: Add `dataExport` table to schema and migration**

Add `dataExport` to `src/db/schema.ts` with columns from the spec and create `drizzle/0003_data_exports.sql` with `CREATE TABLE fitness.data_export (...)` plus indexes.

- [ ] **Step 4: Implement minimal record creation/listing route code**

Update `packages/server/src/routes/export.ts` so `POST /api/export` creates a queued record and returns `{ status: "queued", exportId }`; add `GET /api/export` for authenticated active and completed unexpired records.

- [ ] **Step 5: Run route tests**

Run: `pnpm vitest run packages/server/src/routes/export.test.ts`

Expected: route tests pass.

### Task 2: CSV ZIP Generation

**Files:**
- Modify: `src/export.ts`
- Test: `src/export.test.ts`

- [ ] **Step 1: Write failing CSV tests**

Add tests for CSV escaping, `.csv` file names, compact JSON cell serialization, and `metric-streams.csv` streaming.

- [ ] **Step 2: Run export tests to verify failure**

Run: `pnpm vitest run src/export.test.ts`

Expected: failures because export files are JSON and CSV helpers do not exist.

- [ ] **Step 3: Implement CSV serialization and batched CSV stream**

Replace table filenames with `.csv`, add CSV value/header serialization helpers, and change metric stream batching from JSON array streaming to CSV streaming.

- [ ] **Step 4: Run export tests**

Run: `pnpm vitest run src/export.test.ts`

Expected: export unit tests pass.

### Task 3: R2 Storage and Brevo Email

**Files:**
- Create: `src/export-storage.ts`
- Create: `src/export-email.ts`
- Modify: `package.json`
- Test: `src/export-storage.test.ts`
- Test: `src/export-email.test.ts`

- [ ] **Step 1: Add dependencies**

Run: `pnpm add @aws-sdk/client-s3@3.1037.0 @aws-sdk/s3-request-presigner@3.1037.0 nodemailer@8.0.6 && pnpm add -D @types/nodemailer@8.0.0`

- [ ] **Step 2: Write failing storage/email tests**

Storage tests cover missing R2 env vars, user-prefixed object keys, upload calls, and signed URL generation. Email tests cover missing SMTP env vars and successful send options.

- [ ] **Step 3: Run storage/email tests to verify failure**

Run: `pnpm vitest run src/export-storage.test.ts src/export-email.test.ts`

Expected: failures because modules do not exist.

- [ ] **Step 4: Implement minimal storage/email modules**

`src/export-storage.ts` creates an S3-compatible client for R2, uploads a file, returns `{ objectKey, sizeBytes }`, and signs downloads. `src/export-email.ts` sends Brevo SMTP mail with `BREVO_SMTP_USER`, `BREVO_SMTP_KEY`, and `EXPORT_EMAIL_FROM`.

- [ ] **Step 5: Run storage/email tests**

Run: `pnpm vitest run src/export-storage.test.ts src/export-email.test.ts`

Expected: storage and email unit tests pass.

### Task 4: Worker Status Transitions

**Files:**
- Modify: `src/jobs/queues.ts`
- Modify: `src/jobs/process-export-job.ts`
- Test: `src/jobs/process-export-job.test.ts`

- [ ] **Step 1: Write failing worker tests**

Add tests for processing/completed/failed status updates, user email lookup failure, R2 upload call, and email send call.

- [ ] **Step 2: Run worker tests to verify failure**

Run: `pnpm vitest run src/jobs/process-export-job.test.ts`

Expected: failures because worker only writes a local file and does not update `fitness.data_export`.

- [ ] **Step 3: Implement worker flow**

Update `ExportJobData` to include `exportId`. Worker marks processing, generates a temp ZIP, uploads to R2 key `exports/<userId>/<exportId>/dofek-export.zip`, signs a 7-day link, sends email, marks completed, and marks failed before rethrowing on errors.

- [ ] **Step 4: Run worker tests**

Run: `pnpm vitest run src/jobs/process-export-job.test.ts`

Expected: worker tests pass.

### Task 5: Download Route and Integration

**Files:**
- Modify: `packages/server/src/routes/export.ts`
- Modify: `packages/server/src/export.integration.test.ts`
- Test: `packages/server/src/routes/export.test.ts`

- [ ] **Step 1: Write failing download tests**

Add route tests for `403` on other-user download, `400` for incomplete/expired exports, and `302` redirect to a signed URL for completed owned exports.

- [ ] **Step 2: Run route tests to verify failure**

Run: `pnpm vitest run packages/server/src/routes/export.test.ts`

Expected: failures because download still reads local job files.

- [ ] **Step 3: Implement signed download redirect**

Replace local file download behavior with export-record lookup and `createSignedExportDownloadUrl`.

- [ ] **Step 4: Update integration test expectations**

Update integration tests to assert queued response, export record status, CSV ZIP contents, and user scoping. Mock R2/email at module boundaries in route-level tests; keep DB integration focused on records and CSV generation.

- [ ] **Step 5: Run server export tests**

Run: `pnpm vitest run packages/server/src/routes/export.test.ts packages/server/src/export.integration.test.ts`

Expected: export route and integration tests pass.

### Task 6: Web and Mobile UI

**Files:**
- Modify: `packages/web/src/components/ExportPanel.tsx`
- Add or modify: `packages/web/src/components/ExportPanel.test.tsx`
- Modify: `packages/mobile/app/settings.tsx`
- Modify: `packages/mobile/app/settings.test.tsx`

- [ ] **Step 1: Write failing client tests**

Web and mobile tests should assert that starting an export shows email expectation text, no status polling occurs, active exports are shown, and completed exports are listed with download actions.

- [ ] **Step 2: Run client tests to verify failure**

Run: `pnpm vitest run packages/web/src/components/ExportPanel.test.tsx packages/mobile/app/settings.test.tsx`

Expected: failures because clients still poll/download immediately.

- [ ] **Step 3: Implement UI changes**

Fetch `GET /api/export`, show active and available exports, make `POST /api/export` fire-and-forget with email expectation messaging, and use `/api/export/download/:exportId` for manual downloads from the list.

- [ ] **Step 4: Run client tests**

Run: `pnpm vitest run packages/web/src/components/ExportPanel.test.tsx packages/mobile/app/settings.test.tsx`

Expected: client tests pass.

### Task 7: Infrastructure and Documentation

**Files:**
- Modify: `deploy/storage.tf`
- Modify: `deploy/stack.yml`
- Modify: `README.md`
- Test: infrastructure commands

- [ ] **Step 1: Add R2 bucket/lifecycle**

Add `cloudflare_r2_bucket.exports` and a 7-day `cloudflare_r2_bucket_lifecycle` rule to `deploy/storage.tf`.

- [ ] **Step 2: Add worker env**

Add `EXPORT_R2_BUCKET: dofek-exports` to the `worker` service in `deploy/stack.yml`.

- [ ] **Step 3: Document export delivery secrets**

Add `BREVO_SMTP_KEY`, `BREVO_SMTP_USER`, `EXPORT_EMAIL_FROM`, and `EXPORT_R2_BUCKET` notes to the secrets section in `README.md`.

- [ ] **Step 4: Validate infra config**

Run: `docker stack config -c deploy/stack.yml`

Expected: stack config parses.

Run: `cd deploy && terraform plan`

Expected: plan includes the export bucket and lifecycle changes.

### Task 8: Final Verification and Push

**Files:**
- All changed files

- [ ] **Step 1: Run required pre-push checks**

Run:

```bash
pnpm lint
pnpm test:changed
pnpm tsc --noEmit
cd packages/server && pnpm tsc --noEmit
cd packages/web && pnpm tsc --noEmit
```

- [ ] **Step 2: Run migrations**

Run: `pnpm migrate`

- [ ] **Step 3: Commit and push**

Commit after checks pass, then push the branch.
