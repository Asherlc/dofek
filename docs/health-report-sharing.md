# Health Report Sharing

Shareable weekly and monthly health reports are created through `healthReport.generate` and viewed publicly via `/health-report?token=…`.

## Link expiry

- The server accepts `expiresInDays` as an integer from 1 to 90, or `null` for a non-expiring link. See [`packages/server/src/routers/health-report.ts`](../packages/server/src/routers/health-report.ts).
- Web and mobile share buttons always send a duration. The default is **7 days**. Users can choose **7**, **30**, or **90** days before creating the link.
- Successful share copy (web) and the native share sheet message (mobile) include the server-returned `expiresAt`, formatted with `formatDateMedium` from `@dofek/format`.
- Shared Reports on web lists existing links and shows their expiry when present.

## Non-goals (current slice)

- Selecting which report domains appear in a share
- Revoking or editing an existing share link from mobile
- Annual reports or narrative/lesson layers
