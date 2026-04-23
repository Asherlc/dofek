# iOS Sign In Regression (April 2026)

## Root Cause

TestFlight build `2378` (deployed April 21, 2026) was exported from an **unsigned** archive.

That archive came from the CI iOS native build step with:

- `CODE_SIGNING_ALLOWED=NO`
- `CODE_SIGN_IDENTITY=""`

As a result, deploy-time `xcodebuild -exportArchive` signed an archive that was not built with signed entitlements/capabilities.

## Deterministic Evidence

1. Build run that produced the uploaded archive:
   - CI run: `24749189194`
   - Job: `Build Mobile / iOS Native Build` (`72408236356`)
   - Archive command included `CODE_SIGNING_ALLOWED=NO`.
2. Archive metadata from downloaded `ios-xcarchive` artifact shows:
   - `ApplicationProperties.SigningIdentity = ""`
   - `ApplicationProperties.Team = ""`
3. On-device native Apple auth failure for that build:
   - `AKAuthenticationError Code=-7026`
   - `ASAuthorizationController ... AuthorizationError Code=1000`
   - `Sandbox: ... forbidden-map-ls-database`
4. Backend native Apple endpoint was not hit during failing attempts (`/auth/apple/native` absent in server logs), confirming failure occurred before server exchange.

## What Changed in Workflow

`deploy-ios.yml` now performs a signed `xcodebuild archive` in deploy before export/upload, instead of downloading and exporting the unsigned `ios-xcarchive` artifact.

