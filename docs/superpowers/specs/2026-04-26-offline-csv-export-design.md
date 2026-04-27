# Offline CSV Export Design

## Goal

Data exports should run offline after the user starts them from web or mobile. The user should not need to keep the app open while the export is generated. When the export is ready, Dofek emails the user a download link. Export files are ZIP archives containing CSV files, stored in Cloudflare R2, and deleted automatically after 7 days. The UI should show active exports, set the expectation that completed exports arrive by email, and list completed unexpired exports for the authenticated user.

## Current Behavior

- `packages/server/src/routes/export.ts` starts a BullMQ export job and returns a job ID.
- Web and mobile poll `/api/export/status/:jobId` until completion.
- The worker writes a local ZIP file through `src/export.ts`.
- The clients download the local file through `/api/export/download/:jobId`.
- The ZIP currently contains JSON files.

## Proposed Behavior

1. The authenticated user starts an export.
2. The server enqueues a BullMQ job and immediately returns a queued response.
3. The worker generates a ZIP containing CSV files.
4. The worker uploads the ZIP to a user-scoped prefix inside the dedicated private R2 bucket, `dofek-exports`.
5. The worker records export status, object key, size, completion time, and expiration time in Postgres.
6. The worker emails the user a signed download link through Brevo SMTP.
7. R2 deletes export objects automatically after 7 days.

The email link should also expire after 7 days so the user-facing access window matches R2 retention.

## Architecture

### R2 Storage

Add a dedicated Terraform-managed R2 bucket:

- Bucket: `dofek-exports`
- Location: `WEUR`, matching the existing project buckets
- Lifecycle rule: delete all objects older than 7 days
- Multipart cleanup: abort incomplete uploads after 1 day

Use the existing R2 credentials already injected into the production stack:

- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

Add runtime config:

- `EXPORT_R2_BUCKET=dofek-exports`

Export object keys should include the user ID and job ID, for example:

```text
exports/<user-id>/<export-id>/dofek-export.zip
```

The bucket remains private. Users receive signed URLs generated server-side.

### Export Records

Add a server-side export record table as the source of truth for UI state and user-scoped export history. Do not list R2 objects directly from clients.

Suggested table: `fitness.data_export`

Columns:

- `id uuid primary key default gen_random_uuid()`
- `user_id uuid not null references fitness.user_profile(id) on delete cascade`
- `status text not null` with values `queued`, `processing`, `completed`, `failed`
- `object_key text`
- `filename text not null`
- `size_bytes bigint`
- `created_at timestamptz not null default now()`
- `started_at timestamptz`
- `completed_at timestamptz`
- `expires_at timestamptz not null`
- `error_message text`

Indexes:

- `(user_id, created_at desc)` for the export list
- `(user_id, status)` for active export checks
- `expires_at` for cleanup queries

The worker owns status transitions:

- Route creates `queued`.
- Worker marks `processing` before generation.
- Worker marks `completed` only after R2 upload succeeds.
- Worker marks `failed` with an error message if generation, upload, or email delivery fails.

### Export Format

Change `src/export.ts` to write CSV files instead of JSON files inside the ZIP:

- `activities.csv`
- `activity-intervals.csv`
- `sleep-sessions.csv`
- `body-measurements.csv`
- `nutrition-daily.csv`
- `food-entries.csv`
- `daily-metrics.csv`
- `strength-workouts.csv`
- `strength-sets.csv`
- `lab-panels.csv`
- `lab-results.csv`
- `journal-entries.csv`
- `life-events.csv`
- `health-events.csv`
- `sport-settings.csv`
- `metric-streams.csv`
- `user-profile.csv`

Keep `export-metadata.json` as JSON because it is export metadata rather than tabular user data.

CSV serialization requirements:

- Derive headers from the union of row keys for each exported table.
- Escape commas, quotes, and newlines using standard CSV quoting.
- Serialize `null` and `undefined` as empty cells.
- Serialize `Date` values as ISO strings.
- Serialize objects and arrays, including raw JSON columns, as compact JSON strings inside CSV cells.
- Continue to stream large `metric_stream` exports in batches rather than loading the entire table at once.

### Email Delivery

Use Brevo SMTP through Nodemailer.

Required secrets:

- `BREVO_SMTP_KEY`

Required non-secret or secret config:

- `BREVO_SMTP_USER`
- `EXPORT_EMAIL_FROM`

Brevo SMTP settings:

- Host: `smtp-relay.brevo.com`
- Port: `587`
- Secure: `false`, using STARTTLS

The worker should query `fitness.user_profile.email` for the export user. If the user has no email address, the job should fail loudly with a clear error because email delivery is now the completion mechanism.

The completion email should include:

- A concise subject such as `Your Dofek export is ready`
- The signed download link
- A note that the link and file expire after 7 days

### API and Client Flow

Keep the existing `/api/export` endpoint but change the client-facing behavior:

- `POST /api/export` creates an export record, enqueues the job, and returns `{ status: "queued", exportId }`.
- `GET /api/export` returns the authenticated user's active exports and completed unexpired exports.
- `GET /api/export/download/:exportId` verifies ownership and completion, then redirects to a short-lived R2 signed URL.
- Web and mobile show an immediate success state telling the user the export will arrive by email.
- Web and mobile show when an export is currently `queued` or `processing`.
- Web and mobile list completed, unexpired exports for the user with a download action.
- Clients stop polling for completion as the normal flow.

Remove the local-file download route from the user flow. Keep `/api/export/status/:jobId` only if it remains useful for authenticated diagnostics; it must not expose R2 object keys or become a second download path.

### Error Handling

- Missing R2 config hard-fails with explicit env var names.
- Missing Brevo config hard-fails with explicit env var names.
- Missing user email hard-fails the export job with a clear message.
- Downloading an export for another user returns `403`.
- Downloading an expired, failed, queued, or processing export returns an actionable client error.
- Unexpected email, R2, or export failures propagate so BullMQ marks the job failed and Sentry captures the worker exception through the existing worker integration.

Do not add fallback local download behavior for production. That would create a second delivery path and weaken the offline design.

## Testing

Use TDD for implementation.

Unit tests:

- CSV serialization escapes commas, quotes, newlines, dates, nulls, and nested JSON.
- `generateExport` writes `.csv` table files and still writes metadata.
- Batched metric stream export emits CSV content without loading all rows at once.
- Export job uploads the generated ZIP to R2 and emails the user.
- Export job fails when the user has no email.
- Export records transition from queued to processing to completed with object metadata.
- Export records transition to failed with a specific error message on worker failure.
- Email sender fails loudly when Brevo config is missing.
- R2 storage fails loudly when R2 config is missing.

Integration tests:

- `/api/export` enqueues an offline export and returns a queued response.
- `/api/export` lists only the authenticated user's active and unexpired completed exports.
- `/api/export/download/:exportId` rejects exports owned by another user.
- `/api/export/download/:exportId` redirects to a signed URL for a completed export owned by the authenticated user.
- End-to-end export job produces a ZIP with CSV files.
- Exported data remains scoped to the authenticated user.

Client tests:

- Web settings export panel shows the email-delivery success state.
- Web settings export panel shows active export status.
- Web settings export panel lists completed exports.
- Mobile settings export flow shows the email-delivery success state.
- Mobile settings export flow shows active export status.
- Mobile settings export flow lists completed exports.
- Neither client polls in the normal success path.

Infrastructure validation:

- `terraform plan` for R2 bucket and lifecycle changes.
- `docker stack config -c deploy/stack.yml` after stack env changes.

## Deployment Notes

Required Infisical updates:

- `BREVO_SMTP_KEY` is already set in `prod`.
- Add `BREVO_SMTP_USER`.
- Add `EXPORT_EMAIL_FROM` if treated as secret or sender-specific config.

Required repo config updates:

- Add `EXPORT_R2_BUCKET=dofek-exports` to the `worker` service environment in `deploy/stack.yml`.

After deployment, the production worker must have R2 and Brevo env vars. No manual server edits are required.
