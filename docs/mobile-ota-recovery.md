# Mobile OTA compatibility and recovery

## Compatibility boundary

The app uses Expo's `fingerprint` runtime policy. Native builds and OTA
publications resolve their runtime through `expo-updates`; an older binary
continues using updates for its own runtime. JavaScript that requires a new
native interface belongs to the new runtime. See
[Expo runtime versions](https://docs.expo.dev/eas-update/runtime-versions/)
and the pinned [publisher resolver](https://github.com/mercuretechnologies/xprem/blob/v2.3.22/apps/eoas/src/lib/runtimeVersion.ts).

[`fingerprint.config.js`](../packages/mobile/fingerprint.config.js) adds the
Watch target directory, public update-signing certificate, custom Sentry
podspec, and workspace dependency patches to Expo's native-module and
config-plugin inputs. Dependency patches are included conservatively because
they can change native library code without changing its package version.
The generated Watch app icon is excluded because prebuild regenerates it
from `assets/icon.png`, which is already an Expo fingerprint input. Keep
handwritten Swift, target configuration, entitlements, and resources in the
fingerprint; exclude Watch documentation, test fixtures, and local Swift test
build output, which do not define the shipped interface. Expo documents
`extraSources` and `.fingerprintignore` in its
[fingerprint reference](https://docs.expo.dev/versions/latest/sdk/fingerprint/).
Private signing keys are not fingerprint inputs. Native release detection
covers these explicit inputs as well as the default app assets and mobile
`.gitignore` inputs; see the [release workflow](../.github/workflows/deploy-ios.yml).

The first fingerprint-based release requires a new native build. Existing
`1.12` and `1.13` binaries retain those runtime identifiers; changing the
current policy does not migrate installed binaries. Do not relabel a current
bundle with an old runtime to force delivery. Expo explains the separation of
[native and update layers](https://docs.expo.dev/eas-update/runtime-versions/).

## Release verification

1. Resolve the runtime with the same managed configuration and environment
   used by the native and OTA workflows:

   ```sh
   cd packages/mobile
   node node_modules/expo-updates/bin/cli.js runtimeversion:resolve --platform ios
   ```

2. Use a staging channel and an already-built binary with that runtime to
   test the candidate OTA. Launch the cached app, download the update, and
   relaunch through the normal app lifecycle. Exercise authentication,
   foreground/background transitions, and any native methods touched by the
   candidate. A new binary built from the candidate cannot prove that its
   JavaScript works on the previously shipped native interface. Expo recommends
   testing updates on [preview builds with the same runtime](https://docs.expo.dev/eas-update/runtime-versions/#manually-verify-updates-with-a-smaller-group-of-users).
   PR publishing and preview prebuilds must both set `PREVIEW_CHANNEL=pr-N`
   (and the same bundle identifier, if overridden), because these values change
   the app's managed native configuration. The [preview publisher](../.github/workflows/mobile-preview-ota.yml)
   and [app configuration](../packages/mobile/app.config.js) implement that
   convention; Expo fingerprints the resolved [app configuration](https://docs.expo.dev/versions/latest/sdk/fingerprint/).
   Before publishing, the workflow uses the official EAS CLI to ensure the PR
   channel links to the same-named branch. Uploading a branch alone does not
   create that channel; the pinned server resolves incoming channel names
   through [Expo's channel mapping](https://github.com/mercuretechnologies/xprem/blob/v2.3.16/internal/services/expo.go).
   Channel setup reads EAS directly because the server's management list has a
   [ten-second cache](https://github.com/mercuretechnologies/xprem/blob/v2.3.16/internal/handlers/dashboard_handler.go).
3. When the runtime changes, deliver the new native build through TestFlight
   before testing its OTA. Older runtimes continue with their compatible
   updates. Preserve normal launch behavior: this app starts from cached code
   with a zero network wait and applies a downloaded update on a later launch;
   see [Expo Updates configuration](https://docs.expo.dev/versions/latest/sdk/updates/).

## Recover an incompatible update

1. Capture the affected Sentry event's native build, runtime, update ID,
   release, and embedded-launch flag. Query `/manifest` using the affected
   runtime and production channel. Confirm the returned update matches the
   failure. The server implements the [Expo Updates protocol](https://docs.expo.dev/technical-specs/expo-updates-1/).
2. Review persisted-state changes before rolling back JavaScript. An older
   bundle must still understand the device's current storage. Expo describes
   this [rollback safety requirement](https://docs.expo.dev/eas-update/error-recovery/).
3. Prefer the server's supported `eoas republish --branch main --platform ios`
   flow when a known compatible update is available. Select the affected
   runtime and exact update. Preserve the source commit for provenance. The
   pinned [republish command](https://github.com/mercuretechnologies/xprem/blob/v2.3.22/apps/eoas/src/commands/republish.ts)
   lists stored updates and calls the authenticated `/republish/main` API.
4. If republishing is blocked, diagnose the operation before retrying. With
   approval, use a rollback-to-embedded directive scoped to the affected
   runtime. The pinned [rollback command](https://github.com/mercuretechnologies/xprem/blob/v2.3.22/apps/eoas/src/commands/rollback.ts)
   derives its runtime from the current checkout: do not run it from today's
   configuration to target an old runtime. An explicit operator request to the
   authenticated `POST /rollback/main` endpoint must supply `platform=ios`,
   the exact `runtimeVersion`, and the recorded `commitHash`; see the
   [server handler](https://github.com/mercuretechnologies/xprem/blob/v2.3.16/internal/handlers/rollback_handler.go).
5. Verify a device-shaped request to `/manifest` with `expo-platform`,
   `expo-runtime-version`, `expo-protocol-version: 1`,
   `expo-channel-name: production`, `expo-current-update-id`, and
   `expo-embedded-update-id`. For signed apps, request `expo-expect-signature`
   and verify the directive signature against the bundled certificate.
   Expect `rollBackToEmbedded` while running the broken OTA and
   `noUpdateAvailable` when the current and embedded update IDs match. Also
   verify a different runtime's update remains unchanged. These behaviors are
   implemented in the pinned [manifest handler](https://github.com/mercuretechnologies/xprem/blob/v2.3.16/internal/handlers/manifest_handler.go)
   and specified by the [Expo Updates protocol](https://docs.expo.dev/technical-specs/expo-updates-1/).
6. Confirm recovery on a physical device after its normal update check and
   subsequent launch. Record server verification separately from device
   recovery; publishing a directive does not prove every installation has
   downloaded it. Expo distinguishes [downloading and applying updates](https://docs.expo.dev/eas-update/download-updates/).

Keep tokens and private signing keys out of command arguments, logs, and
incident notes. Use the repository's existing Infisical environment wrapper
for authenticated operator commands; the [deployment guide](../deploy/README.md#production-secrets)
describes secret ownership.
