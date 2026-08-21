---
name: ios-simulator-audit
description: Build, ad-hoc sign, install, launch, and audit the Dofek iOS app in Simulator with XcodeBuildMCP. Use for real iOS runtime exploration, Release-only reproduction, native accessibility snapshots, deep links, screenshots, and app logs.
---

# iOS Simulator Audit

Read [`packages/mobile/README.md`](../../../packages/mobile/README.md) and
[`packages/mobile/AGENTS.md`](../../../packages/mobile/AGENTS.md) first.

## Preconditions

1. Confirm Xcode command-line tools and at least one iOS Simulator runtime are
   installed.
2. Confirm the repository MCP entries exist in `.mcp.json` and
   `.codex/config.toml`. XcodeBuildMCP's setup and tool catalog are documented at
   <https://www.xcodebuildmcp.com/#get-started>.
3. Boot one simulator and record its UDID:

   ```bash
   rtk xcrun simctl list devices available
   rtk xcrun simctl boot <SIMULATOR_UDID>
   ```

4. Start the target API stack and verify its health before building. Use a fresh,
   isolated account for mutating paths.

## Canonical Release Audit Build

Run from `packages/mobile` with real values supplied through the environment:

```bash
rtk env \
  EXPO_PUBLIC_SERVER_URL=http://127.0.0.1:3100 \
  EXPO_PUBLIC_SENTRY_DSN=https://public-key@sentry.example/project-id \
  SENTRY_DISABLE_AUTO_UPLOAD=true \
  xcodebuild -quiet \
  -workspace ios/Dofek.xcworkspace \
  -scheme Dofek \
  -configuration Release \
  -destination 'platform=iOS Simulator,id=<SIMULATOR_UDID>' \
  -derivedDataPath .context/ReleaseAuditDerivedData \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY=- \
  DEVELOPMENT_TEAM= \
  PROVISIONING_PROFILE_SPECIFIER= \
  build
```

- Keep the destination specific, but do **not** add a global
  `-sdk iphonesimulator`. The `Dofek` scheme also builds a watchOS target; a
  global SDK override forces that target through the wrong platform and creates
  false app-icon and SDK failures.
- Keep local ad-hoc signing (`CODE_SIGN_IDENTITY=-`). Disabling signing removes
  the app's keychain entitlements and makes SecureStore fail, which is an audit
  artifact rather than an application bug.
- Do not override `INFOPLIST_FILE` globally. That strips the main target's
  background-mode declarations and can create a CoreBluetooth launch crash.
- A canonical build must use the checked-in target files. Never file a build bug
  from a temporary global build-setting override.

Expo documents Release-like local builds and Simulator limitations at
<https://docs.expo.dev/guides/local-app-production/> and
<https://docs.expo.dev/workflow/ios-simulator/#limitations>.

## Install, Launch, and Capture

With the configured MCP available, prefer its simulator build/install/launch,
UI snapshot, screenshot, and log tools. The CLI fallback is:

```bash
rtk pnpm dlx xcodebuildmcp@2.6.2 simulator install \
  --simulator-id <SIMULATOR_UDID> \
  --app-path .context/ReleaseAuditDerivedData/Build/Products/Release-iphonesimulator/Dofek.app

rtk pnpm dlx xcodebuildmcp@2.6.2 simulator launch-app \
  --simulator-id <SIMULATOR_UDID> \
  --bundle-id com.dofek.app

rtk pnpm dlx xcodebuildmcp@2.6.2 simulator snapshot-ui \
  --simulator-id <SIMULATOR_UDID> \
  --output json
```

Element references expire quickly. Capture a fresh snapshot immediately before
every tap or swipe. Use `wait-for-ui --predicate settled --timeout-ms 15000`
after navigation or permission prompts.

Open software-only routes directly when a visible control is blocked by the bug
under investigation:

```bash
rtk xcrun simctl openurl <SIMULATOR_UDID> dofek://settings
```

The first custom-scheme open can show an iOS confirmation sheet; activate its
native Open button through a fresh accessibility snapshot.

## Audit Checklist

- Verify a real app screen, not merely a process, splash screen, Expo launcher,
  or development menu.
- Exercise login/registration, every tab, Settings, providers, onboarding,
  support, empty states, error states, and at least one mutating path.
- Run native accessibility snapshots. Compare visible controls with reported
  tappable targets; native Back/tab controls provide a useful control group.
- Capture the exact server request, first fatal server log line, app-visible
  message, and source path before filing a bug.
- Test malformed deep links for dynamic routes.
- Treat BLE, watch, background delivery, and motion behavior as unverified in
  Simulator unless the result is specifically about graceful unavailable-device
  handling.
- Re-check the app and server logs after exploration. Do not classify simulator
  runtime warnings or temporary build overrides as product bugs.

## Cleanup

Stop the app when finished. Tear down only the explicitly named isolated Compose
project created for the audit; preserve other workspaces, containers, images, and
volumes. Confirm temporary source or target scaffolding has no Git diff before
reporting completion.
