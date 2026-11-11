# Mobile OTA validation record — 2026-10-23

Recorded operator results for [PR 3060](https://github.com/Asherlc/dofek/pull/3060).
Times below use UTC; the recovery occurred on October 24 UTC, October 23 locally.
The [incident baseline](production-incident-baseline.md#2026-10-23--recover-runtime-112-and-automate-ota-compatibility)
records the production scope and unresolved republish operation.

## Unit and mobile suites

Before adding the preview-channel command, `pnpm test --run` completed with:

```text
Test Files  1325 passed | 2 skipped (1327)
     Tests  20476 passed | 19 skipped (20495)
```

After adding the command and its eleven tests, the same command completed with:

```text
Test Files  1326 passed | 2 skipped (1328)
     Tests  20487 passed | 19 skipped (20506)
  Duration  119.35s
```

The focused command was
`pnpm exec vitest run --project unit scripts/ensure-mobile-preview-channel.test.ts`.
It failed before implementation and passed all eleven cases afterward. The
[test source](../scripts/ensure-mobile-preview-channel.test.ts) covers existing
and missing channels, pagination, mapping conflicts, CLI failure, temporary
directory cleanup, invalid channel names, and missing configuration.

## Build and policy checks

The following commands exited zero after the dependency updates:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm --dir packages/server typecheck`
- `pnpm --dir packages/web typecheck`
- `pnpm --dir packages/mobile typecheck`
- `pnpm exec cspell --no-progress`
- `actionlint -shellcheck='' .github/workflows/deploy-ios.yml .github/workflows/mobile-preview-ota.yml`
- `pnpm knip` with the CI public Sentry fixture
- `pnpm audit --prod --audit-level=high --ignore-registry-errors`
- `pnpm install --frozen-lockfile`
- `pnpm --dir packages/mobile exec expo install --check`
- `pnpm --dir packages/mobile exec expo prebuild --no-install --platform ios`
- `pnpm --dir packages/mobile exec expo export --platform ios`

Expo commands used the existing Infisical environment wrapper. The audit's
remaining findings were twelve moderate findings and one previously ignored
high finding. Expo reported `Dependencies are up to date`. SQL lint retained
its existing large-file warnings; no gate or configuration was relaxed.
The [hosted checks](https://github.com/Asherlc/dofek/pull/3060/checks) track
runner validation separately from this local record.

## Runtime compatibility probes

With temporary source edits restored after each probe, Expo's runtime resolver
changed its hash for the Swift bridge, Watch Swift source, public certificate,
custom Sentry podspec, and workspace dependency patch. JavaScript-only and
Watch documentation edits preserved it. Regenerated Watch icon metadata also
preserved it. These inputs are defined in the
[fingerprint configuration](../packages/mobile/fingerprint.config.js) and
[generated-input exclusions](../packages/mobile/.fingerprintignore).

The actual Expo native build-resource generator and runtime resolver agreed
for production and preview configurations. For `PREVIEW_CHANNEL=pr-3060`, the
macOS generator and the [Linux publisher](https://github.com/Asherlc/dofek/actions/runs/40045331633)
both produced `9e4ccbfa5b99cbf23b30eed2f5e4ba431e6d94a3`.

Independent review identified preview configuration mismatch, missing native
release triggers, and omitted certificate and custom podspec inputs. Those
findings were fixed before publication. A separate review of the new channel
command checked its CLI arguments and JSON schemas against EAS CLI 25.3.0
source and found no actionable issues. See the
[resulting changes and review discussion](https://github.com/Asherlc/dofek/pull/3060/files).

## Delivery checks

For runtime `1.12`, update `1792800833307` published a rollback directive:

```json
{"type":"rollBackToEmbedded","parameters":{"commitTime":"2026-10-24T00:13:54.000Z"}}
```

Requests whose current and embedded IDs matched returned `noUpdateAvailable`.
Both directive signatures verified using Node's `verify("RSA-SHA256", ...)`
against the [bundled certificate](../packages/mobile/certs/certificate.pem).
Runtime `1.13` retained update `dc875933-9f57-24f5-53c7-751f61ff1c76` during
the recovery checks. Physical-device recovery remains unverified.

After creating the missing PR channel, running
`pnpm tsx scripts/ensure-mobile-preview-channel.ts pr-3060` with the existing
Infisical environment reported `Preview channel pr-3060: existing`.
The client manifest command
`pnpm tsx scripts/check-ota-manifest.ts --channel pr-3060 --runtime-version 9e4ccbfa5b99cbf23b30eed2f5e4ba431e6d94a3`
returned:

```text
id:              279a3d4a-c44c-d4de-c7ac-2955a9c7f88f
createdAt:       2026-10-24T00:32:42.000Z
runtimeVersion:  9e4ccbfa5b99cbf23b30eed2f5e4ba431e6d94a3
launchAsset:     b0ef405fa8e47fc84590725cfbc7bb6f
assets:          42
```

The [recovery runbook](mobile-ota-recovery.md) describes the required headers,
signature checks, and physical-device verification boundary.
