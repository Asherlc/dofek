---
name: testflight-crash-log
description: Fetch TestFlight crash submissions and raw crash logs from App Store Connect API using Infisical-managed credentials.
---

# TestFlight Crash Log

Use this skill when a user asks for TestFlight/App Store Connect crash logs and wants CLI/API evidence.

## What this does

- Reads App Store Connect API credentials from Infisical (`prod` by default):
  - `APP_STORE_CONNECT_KEY_ID`
  - `APP_STORE_CONNECT_ISSUER_ID`
  - `APP_STORE_CONNECT_KEY_BASE64`
- Creates an ES256 JWT for App Store Connect API.
- Resolves app ID from bundle ID.
- Reads beta build usage metrics for recent builds (`installCount`, `sessionCount`, `crashCount`).
- Lists latest beta crash submissions.
- Fetches crash log text for a selected submission.

## Script

- `.agents/skills/testflight-crash-log/scripts/fetch_testflight_crash_log.ts`

## Usage

```bash
# Latest crash for default bundle id (com.dofek.app)
pnpm tsx .agents/skills/testflight-crash-log/scripts/fetch_testflight_crash_log.ts

# Metrics only (no crash log body)
pnpm tsx .agents/skills/testflight-crash-log/scripts/fetch_testflight_crash_log.ts \
  --skip-build-metrics

# Different bundle id + keep full log file
pnpm tsx .agents/skills/testflight-crash-log/scripts/fetch_testflight_crash_log.ts \
  --bundle-id com.example.app \
  --save-log /tmp/testflight-crash.log

# Fetch a specific submission id
pnpm tsx .agents/skills/testflight-crash-log/scripts/fetch_testflight_crash_log.ts \
  --submission-id <BETA_FEEDBACK_CRASH_SUBMISSION_ID>
```

## Required tooling

- `infisical` CLI authenticated (`infisical login`)
- `pnpm` / `tsx` (from repo dependencies)

## Output expectations

The script prints:

1. app name/app id
2. recent build metrics (`installCount`, `sessionCount`, `crashCount`)
3. latest crash submission ids + timestamps/devices
4. selected submission id
5. `Exception Type` and `Termination Reason` lines
6. first N lines of crash log (default 80)

## Notes

- `betaBuildUsages` metrics are the reliable first check for whether a build has sessions/crashes.
- `betaFeedbackCrashSubmissions` are feedback-linked crash logs and may be sparse even when crashes exist.
- Keep secrets masked in chat output. Do not print full key material.
