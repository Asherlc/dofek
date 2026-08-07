# Health Report Sharing

Shareable weekly and monthly health reports are created through `healthReport.generate` and viewed publicly via `/health-report?token=…`.

## Link expiry

- The server accepts `expiresInDays` as an integer from 1 to 90, or `null` for a non-expiring link. See [`packages/server/src/routers/health-report.ts`](../packages/server/src/routers/health-report.ts).
- Shared client durations live in `HEALTH_REPORT_SHARE_EXPIRY_OPTIONS` / `DEFAULT_HEALTH_REPORT_SHARE_EXPIRY_DAYS` from `dofek-server/health-report-share-expiry` (currently **7**, **30**, and **90** days; default **7**).
- Web and mobile share buttons always send one of those durations.
- Successful share copy (web) and the native share sheet message (mobile) include the server-returned `expiresAt`, formatted with `formatDateMedium` from `@dofek/format`.
- Shared Reports on web lists existing links and shows their expiry when present.

## Non-goals (current slice)

- Selecting which report domains appear in a share
- Revoking or editing an existing share link from mobile
- Annual reports or narrative/lesson layers
