# Durable File Uploads

Browser file imports use a private Cloudflare R2 bucket and never stream the browser request body through a web replica. The browser first computes a full-file SHA-256 incrementally, creates a Postgres upload session through tRPC, and uploads stable 16 MiB parts to short-lived, exact `UploadPart` URLs. Cloudflare documents that presigned URLs are bearer tokens, that browser use still requires bucket CORS, and that the signed request must match its authorization: <https://developers.cloudflare.com/r2/api/s3/presigned-urls/> and <https://developers.cloudflare.com/r2/buckets/cors/>.

Postgres table `fitness.file_upload` is the source of truth for ownership and lifecycle state. Object keys are opaque and user scoped: `imports/<user-id>/<upload-id>/source`. The original filename is display metadata only. `fitness.file_upload_outbox` atomically records the deterministic `file-import-<upload-id>` BullMQ handoff in the same statement that moves an upload to `queued`.

Before finalization, the server obtains the authoritative R2 part list and verifies consecutive part numbers, exact expected sizes, and ETags. R2 requires every multipart part except the final part to have the same size and be at least 5 MiB; it permits at most 10,000 parts: <https://developers.cloudflare.com/r2/objects/upload-objects/>. A multipart ETag is not a full-file SHA-256, so the worker streams the object through SHA-256 and byte-count verification before import, following the distinction in the S3 multipart integrity model: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html>.

The worker owns any temporary seekable file required by a parser. It downloads with `pipeline()`, validates ZIP signature and structure, limits expanded bytes and entry count, rejects unsafe paths, and removes the work directory after handles close. Garmin jobs may retain their verified worker file only while BullMQ child jobs are pending.

## Recovery and cleanup

The worker process runs two independent periodic loops:

- The outbox dispatcher retries unpublished events and uses the deterministic job ID so Redis failures cannot create a second logical import.
- Reconciliation expires stale sessions and multipart uploads, queues completed R2 objects that missed handoff, requeues processing records stale for two hours, removes terminal source objects after seven days, and deletes R2 objects older than one day that have no database record.

Terraform adds a seven-day raw-object lifecycle and a one-day incomplete-multipart abort policy as a safety net. Cloudflare notes that incomplete multipart uploads otherwise default to cleanup after seven days and supports lifecycle-based abort: <https://developers.cloudflare.com/r2/buckets/object-lifecycles/>.

## Operations

Use `uploadId` to correlate the browser, tRPC calls, Postgres row, R2 key, outbox row, BullMQ job, worker logs, metrics, and Sentry context. Inspect `fitness.file_upload` and `fitness.file_upload_outbox` before manually intervening. Do not enqueue a second ad hoc job; restore the outbox row to `pending` or allow reconciliation to do so.

Required production configuration is `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `IMPORT_R2_BUCKET=dofek-imports`. The R2 credentials must permit multipart and object operations only on the private imports bucket. Before rollout, apply migration `0053_file_upload_state_machine.sql`, apply the Terraform bucket/CORS/lifecycle resources, verify the three R2 credential values in Infisical, and then roll web and worker together.
