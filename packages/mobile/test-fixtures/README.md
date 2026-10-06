# Native regression fixtures

`AppleAuthenticationErrorDiagnostics.test.swift` exercises the installed
patched Apple diagnostic helper using synthetic NSError inputs. It verifies
domain/code classification, redaction, and non-retention of the source error.
NSError exposes domain, code, and userInfo as documented by
[Apple](https://developer.apple.com/documentation/foundation/nserror).

From the repository root, run:

```bash
pnpm tsx scripts/test-apple-auth-diagnostics.ts
```

The [runner](../../../scripts/test-apple-auth-diagnostics.ts) compiles the
production helper and fixture with `xcrun swiftc` and executes the resulting
binary. The [iOS Native Build job](../../../.github/workflows/build-mobile.yml)
runs the same command. Fixtures stay outside Expo Router's route-only `app`
directory ([Expo Router concepts](https://docs.expo.dev/router/basics/core-concepts/#6-non-navigation-components-live-outside-the-srcapp-directory)).
