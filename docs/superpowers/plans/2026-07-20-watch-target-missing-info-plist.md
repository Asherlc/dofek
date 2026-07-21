# Watch target references a missing Info.plist

## Summary

The generated `DofekWatch` Xcode target points at `targets/DofekWatch/Info.plist`, but the file is not present in the repository. Once the separate icon-catalog failure is bypassed, Xcode stops on this missing build input.

## Runtime evidence

- A Release iOS Simulator build fails with exit code 65.
- First fatal diagnostic: `Build input file cannot be found: '.../packages/mobile/targets/DofekWatch/Info.plist'.`
- Both watch target configurations in `ios/Dofek.xcodeproj/project.pbxproj` set `INFOPLIST_FILE = ../targets/DofekWatch/Info.plist`.
- `targets/DofekWatch/` contains Swift sources, target configuration, tests, and assets, but no `Info.plist`.
- The target also sets `GENERATE_INFOPLIST_FILE = YES`, leaving its generated/native configuration internally inconsistent.

## Expected behavior

The canonical watch target configuration either supplies its declared Info.plist or relies solely on Xcode-generated Info.plist metadata, and the full iOS scheme builds successfully.

## Test-first plan

1. Preserve the failing Release simulator build as the regression reproduction.
2. Identify whether `expo-target.config.js` or checked-in Xcode settings are the canonical owner of watch target plist generation.
3. Choose one plist source of truth: generate the file from target configuration or remove the stale explicit `INFOPLIST_FILE` reference and provide required keys through build settings.
4. Regenerate native target files if applicable and verify the configuration survives regeneration.
5. Re-run the Release simulator build without command-line plist workarounds.
6. Verify required watch capabilities, bundle identifiers, privacy strings, and extension metadata remain present in the built product.

## Acceptance criteria

- No Xcode build setting references a nonexistent plist.
- The watch target obtains all required plist metadata from one canonical source.
- The full `Dofek` Release scheme builds for the iOS Simulator.
- Regenerating the native project does not reintroduce the broken reference.
