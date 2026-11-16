# Database Backup Freshness and Recovery

This runbook covers the production PostgreSQL backups created by Databasus and
stored in the private `dofek-db-backups` Cloudflare R2 bucket.

## Recovery Contract

Production is healthy only when all of these conditions hold:

- The `dofek_databasus` Swarm service has one desired replica and one running
  task.
- The newest object in `dofek-db-backups` is less than 24 hours old.
- A real restore verification has succeeded after a backup-system incident or
  configuration change.

Fresh object metadata is necessary but does not prove that a backup can be
restored. Current Databasus releases make the same distinction and provide
restore verification that restores the latest backup into a throwaway database
and compares it with the source:
<https://databasus.com/restore-verification>.

The `Database Backup Freshness` GitHub Actions workflow checks R2 every six
hours. GitHub notes that scheduled workflows run from the default branch and
can be delayed during periods of high Actions load, so the production deploy
workflow runs the same check after every successful full-stack rollout:
<https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule>.

## Freshness Check

Run the same check locally with Infisical-provided R2 credentials:

```bash
pnpm tsx scripts/with-env.ts -- pnpm check:database-backup-freshness
```

The command lists every page in `dofek-db-backups`, validates each returned
timestamp, and fails when the bucket is empty or the newest object is at least
24 hours old. R2 implements the S3 `ListObjectsV2` operation, including
continuation tokens:
<https://developers.cloudflare.com/r2/api/s3/api/#implemented-object-level-operations>.
The AWS SDK returns at most 1,000 objects per request, so the continuation loop
is required even when the bucket is currently small:
<https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-client-s3/Class/ListObjectsV2Command/>.

Any non-zero result is an incident. Do not convert it to a warning, add retries,
or increase the 24-hour threshold.

## Triage a Stale or Missing Backup

1. Inspect the freshness workflow and retain its first fatal line:

   ```bash
   gh run list --workflow database-backup-freshness.yml --limit 10
   gh run view <run-id> --log-failed
   ```

2. Confirm the scheduler's desired and running state without printing its
   environment:

   ```bash
   ssh dofek-server 'docker service ls --filter name=dofek_databasus'
   ssh dofek-server 'docker service ps dofek_databasus --no-trunc'
   ssh dofek-server 'docker service logs --raw --timestamps --tail 200 dofek_databasus'
   ```

3. If the service is `0/0`, inspect the deployed stack and Oracle override in
   source. Fix the desired state through the normal stack deployment; do not
   manually scale production as the permanent repair.

4. If the service is `1/1`, open the Databasus UI and verify that its existing
   database, schedule, and S3-compatible R2 storage target are present.
   Databasus stores those settings and its encryption material under the
   service's `/databasus-data` directory; production bind-mounts that directory
   from `/mnt/dofek-data/databasus`. Databasus documents that its internal
   `pgdata` and `secret.key` are both required to recover the full UI state:
   <https://databasus.com/faq#how-to-backup-databasus-itself>.

5. If a backup fails with an application restart while `pg_dump` is running,
   compare the kernel OOM timestamp with the service's memory limit. A
   `1/1` task does not rule out a memory-cgroup kill during backup. Databasus
   lists 500 MB RAM as its minimum
   ([installation requirements](https://databasus.com/installation/)); this
   stack assigns it `512M`. The memory fix alone is not recovery evidence:
   local synthetic backup/restore tests validate only their fixture. After
   deployment, require a fresh production backup, the freshness check, and an
   isolated restore of that backup.

6. Trigger a backup from Databasus. Re-run the freshness command and require a
   successful result before declaring the recovery point current.

Never inspect or print a Swarm service's environment. Use the authorized
Infisical workflow to verify credential presence.

## Recover Databasus Administrator Access

Databasus manages its users in its own persistent database; the service's
presence in infrastructure code does not provision its administrator password.
Retrieve the current credential privately from Infisical's `prod` environment:
`DATABASUS_ADMIN_PASSWORD` and account name `DATABASUS_ADMIN_EMAIL` (currently
the legacy `admin` account). These are operator credentials, not
application-service environment inputs.

With the owner's explicit approval, first use `GET /api/v1/users/me` over HTTPS
to verify that the authenticated account matches the intended administrator
from `DATABASUS_ADMIN_EMAIL`; retain its user ID for the subsequent identity
check ([profile endpoint](https://github.com/databasus/databasus/blob/v3.32.1/backend/internal/features/users/controllers/user_controller.go#L274-L295)).
Then use `PUT /api/v1/users/change-password` over HTTPS. This endpoint changes
the authenticated user's password. The pinned `v3.32.1` API accepts
the new password as JSON field `newPassword`, with Bearer authentication
([controller](https://github.com/databasus/databasus/blob/v3.32.1/backend/internal/features/users/controllers/user_controller.go#L189-L232),
[request schema](https://github.com/databasus/databasus/blob/v3.32.1/backend/internal/features/users/dto/dto.go#L38-L40)).
Use an HTTP client that reads the password and token from private memory or
protected files; do not place either value in command arguments, URLs, chat,
shell history, request traces or logs. After a successful change, verify sign-in
with the replacement and confirm the same administrator ID with `/users/me`.
Only then save the replacement privately in Infisical.

Without an authenticated session, the supported email recovery flow is
`POST /api/v1/users/send-reset-password-code`, followed by
`POST /api/v1/users/reset-password` with `email`, `code` and `newPassword` in
the JSON request body. It requires working mail delivery and a valid account email;
the placeholder `admin` does not satisfy the email validation
([pinned routes](https://github.com/databasus/databasus/blob/v3.32.1/backend/internal/features/users/controllers/user_controller.go#L399-L485),
[request schemas](https://github.com/databasus/databasus/blob/v3.32.1/backend/internal/features/users/dto/dto.go#L98-L107)).
Do not assume this flow is configured on the production instance.

The legacy CLI is not a private-input alternative: its
[`--new-password` flag is the only password input](https://github.com/databasus/databasus/blob/v3.32.1/backend/cmd/main.go#L135-L169),
with no supported stdin, environment-variable or password-file mode. Passing
the flag through `docker exec` places the password in Docker's exec event
arguments ([Docker implementation](https://github.com/moby/moby/blob/06db1734267bf7770914b417bff6556d835bf8cc/daemon/exec.go#L151-L154)).
Starting an interactive shell first does not remove it from the reset process's
arguments. If neither supported HTTP path is available, stop for an explicit
owner decision; do not promise that the CLI keeps the password out of process
arguments or event records, and do not invent an unsupported input option.

The supported password update changes the hash and time at which it was set,
without replacing backup keys, schedules or stored backups
([pinned implementation](https://github.com/databasus/databasus/blob/v3.32.1/backend/internal/features/users/repositories/user_repository.go#L55-L61)).

## Prove the Backup Can Restore

Never test a restore against production.

1. Record the selected backup identifier and R2 last-modified timestamp.
2. If the deployed Databasus version exposes restore verification, use it on
   an isolated host with Docker and enough space for the encrypted backup,
   restored database, and safety margin. The official verification flow
   downloads the latest backup, restores it into an ephemeral database
   container, compares table row counts, and tears the container down:
   <https://databasus.com/restore-verification>. Otherwise, use the documented
   manual recovery path below to restore into an isolated scratch database.
3. Require the restore command to exit successfully. Record the restored
   PostgreSQL version, table-count comparison, and representative application
   sanity queries without recording credentials or health data.
4. Destroy the scratch database and any decrypted temporary files.
5. Attach the verification evidence to the incident or deploy record.

If the Databasus UI is unavailable, manual recovery requires the encrypted
backup object, its matching `.metadata` object, and the original
`databasus-data/secret.key`. Databasus documents decrypting the pair and using
`pg_restore` for a logical PostgreSQL backup:
<https://databasus.com/how-to-recover-without-databasus>.
Stop and escalate if any of those three inputs is missing; an object timestamp
alone is not a recoverable database.

## Completion Checklist

- `dofek_databasus` is stable at `1/1`.
- The freshness checker reports a recovery point under 24 hours old.
- The real restore verification passes in isolation.
- The incident baseline records symptoms, evidence, root cause, fix,
  validation, remaining risk, and follow-up work.
- The next scheduled freshness workflow completes successfully.
