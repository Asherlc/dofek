---
name: db-incident-response
description: Triage and remediate production Postgres incidents (recovery mode, restart loops, disk pressure) with root-cause-first workflow.
---

# DB Incident Response

Use this skill when production Postgres is unhealthy (for example: `in recovery mode`, repeated restarts, `No space left on device`, healthcheck failures).

## Goals

1. Confirm the exact failure mode with evidence.
2. Identify root cause before applying resilience/workflow tweaks.
3. Restore service safely with minimal blast radius.
4. Capture prevention actions in docs and infra.

## 1) Collect evidence first

```bash
# Service and container state
ssh <SERVER> 'docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"'
ssh <SERVER> 'docker inspect dofek-db --format "{{json .State.Health}}"'

# DB logs (recent)
ssh <SERVER> 'docker logs --since 2h dofek-db 2>&1 | tail -n 300'

# Host resources
ssh <SERVER> 'df -h && free -h && docker system df'
```

If logs include `No space left on device`, treat this as a storage incident immediately.

## 2) Determine root cause category

- Storage exhaustion: `No space left on device`, full root/data filesystem.
- Crash loop without ENOSPC: check OOM/kernel logs and postgres panic/fatal lines.
- Corruption signals: repeated redo/checkpoint issues after space is recovered.

Never default to adding deploy retries/timeouts until root cause category is confirmed.

## 3) Emergency recovery (storage incident)

Use only as needed to restore DB availability:

1. Reclaim safe space first (logs/cache/prunable artifacts).
2. If still blocked, remove non-critical services/artifacts to free headroom.
3. Restart `dofek-db`.
4. Verify:
   - DB container healthy
   - `SELECT now(), pg_is_in_recovery();` returns `false`
   - app `/healthz` returns OK

## 4) Post-recovery sizing and growth analysis

```bash
# Top tables and indexes
ssh <SERVER> "docker exec dofek-db psql -U health -d health -P pager=off -c \
\"SELECT n.nspname, c.relname, c.relkind, pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size \
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace \
 WHERE n.nspname NOT IN ('pg_catalog','information_schema') \
 ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 30;\""
```

For this project, `fitness.metric_stream` is a known high-growth table. Use `docs/metric-stream-timescaledb-runbook.md`.

## 5) Prevention checklist

- Ensure DB storage is sized with headroom.
- Ensure DB data path is on intended persistent volume.
- Add/verify disk alerts (warn/critical/page thresholds).
- Add/verify DB unhealthy/recovery alerts.
- Apply Timescale hypertable/compression/retention plan for `metric_stream`.
- Update docs/runbooks with concrete timestamps, symptoms, and commands used.
