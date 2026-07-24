# WatchConnectivity Durable File Receipt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist WatchConnectivity files synchronously without depending on Expo module lifetime.

**Architecture:** A Foundation-only `WatchFileInbox` performs durable synchronous persistence, and a process-owned `WatchFileReceiver` invokes it before optionally notifying a weak observer. The `WCSessionDelegate` strongly owns the shared receiver, while `WatchMotionModule` shares the same inbox and acts only as the optional JavaScript notification observer.

**Tech Stack:** Swift 5.9, Foundation, WatchConnectivity, Expo Modules Core, Sentry Cocoa, XCTest

## Global Constraints

- Write and observe the failing native lifecycle test before editing production Swift.
- Move the received temporary file synchronously before `session(_:didReceive:)` returns.
- JavaScript event emission is optional and happens only after persistence.
- Report final persistence failures to Sentry.
- Never remove the received source after a failed fallback copy.
- Do not change JavaScript APIs, sync scheduling, parsing, or acknowledgement behavior.

---

### Task 1: Process-owned Watch file inbox

**Files:**
- Create: `packages/mobile/modules/watch-motion/ios/WatchFileInbox.swift`
- Create: `packages/mobile/modules/watch-motion/Tests/WatchFileReceiverTests.swift`
- Modify: `packages/mobile/modules/watch-motion/Package.swift`

**Interfaces:**
- Produces: `WatchFileInbox.init(pendingDirectory:fileManager:)`
- Produces: `WatchFileInbox.persistReceivedFile(at:metadata:) throws -> String`
- Produces: `WatchFileInbox.listPendingFileNames() throws -> [String]`
- Produces: `WatchFileReceiver.init(inbox:reportError:)`
- Produces: `WatchFileReceiver.receive(fileURL:metadata:)`
- Produces: `WatchFileReceiver.observer: WatchFileReceiverObserver?`

- [ ] **Step 1: Add failing lifecycle and error-retention tests**

Create `WatchFileReceiverTests` that writes a source fixture into a temporary
directory, calls:

```swift
let inbox = WatchFileInbox(pendingDirectory: pendingDirectory)
let receiver = WatchFileReceiver(inbox: inbox) { error in
    XCTFail("Unexpected persistence error: \(error)")
}
receiver.receive(
    fileURL: sourceURL,
    metadata: ["type": "accelerometer_samples", "sampleCount": 1]
)
let moduleObserver = ModuleObserverSpy()
receiver.observer = moduleObserver
```

Assert that exactly one `watch-accel-*.json.gz` file exists in the inbox, its
bytes match the fixture, the source URL no longer exists, and the observer
created after receipt did not receive a retroactive event.

Add a second test that writes a regular file at `pendingDirectory`, invokes the
receiver, and asserts that the reporter receives an error and the source URL
still exists.

- [ ] **Step 1a: Cover fallback and notification ordering**

Use a controlled `FileManager` subclass to force move failure. Verify successful
copy retains the source and preserves destination bytes; verify move and copy
failure reports both errors and retains the source. Attach an observer before
receipt and verify the persisted bytes are readable inside its callback.

- [ ] **Step 2: Include the new production source in SwiftPM and verify RED**

Update the target sources:

```swift
sources: ["SampleFileParser.swift", "WatchFileInbox.swift"]
```

Run:

```bash
cd packages/mobile/modules/watch-motion && swift test
```

Expected: compilation fails because `WatchFileInbox`,
`WatchFileReceiver`, and `WatchFileReceiverObserver` do not exist.

- [ ] **Step 3: Implement the minimal Foundation-only inbox and receiver**

Implement:

```swift
protocol WatchFileReceiverObserver: AnyObject {
    func watchFileReceiver(
        didPersist fileName: String,
        metadata: [String: Any]?
    )
}

final class WatchFileInbox {
    static let shared = WatchFileInbox(pendingDirectory: defaultPendingDirectory)

    let pendingDirectory: URL

    init(pendingDirectory: URL, fileManager: FileManager = .default)
    func persistReceivedFile(at sourceURL: URL, metadata: [String: Any]?) throws -> String
    func listPendingFileNames() throws -> [String]
}

final class WatchFileReceiver {
    var observer: WatchFileReceiverObserver? { get set }

    init(inbox: WatchFileInbox, reportError: @escaping (Error) -> Void)
    func receive(fileURL: URL, metadata: [String: Any]?)
}
```

`persistReceivedFile` must create the directory, choose the existing
accelerometer/altitude prefix, try `moveItem`, and fall back to `copyItem`
without manually deleting the system-managed temporary source. If copy fails,
throw an error that retains both move and copy failure descriptions.
Synchronize the receiver's weak observer storage with `NSLock`, copying the
observer to a local strong reference before notification and never holding the
lock while calling observer code.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
cd packages/mobile/modules/watch-motion && swift test
```

Expected: all `WatchMotionTests` pass.

### Task 2: Connect the native delegate and Expo module

**Files:**
- Modify: `packages/mobile/modules/watch-motion/ios/WatchMotionModule.swift`
- Modify: `packages/mobile/modules/watch-motion/ios/ExpoWatchMotion.podspec`

**Interfaces:**
- Consumes: `WatchFileInbox.shared`
- Consumes: `WatchFileReceiver.receive(fileURL:metadata:)`
- Implements: `WatchFileReceiverObserver`

- [ ] **Step 1: Give the process delegate durable ownership**

Make `WatchSessionDelegateHolder` strongly own:

```swift
private let receiver = WatchFileReceiver(
    inbox: .shared,
    reportError: { error in SentrySDK.capture(error: error) }
)
```

Have its weak `module` property update `receiver.observer`. Replace the
module-dependent receipt branch with:

```swift
receiver.receive(
    fileURL: file.fileURL,
    metadata: file.metadata as? [String: Any]
)
```

- [ ] **Step 2: Make the Expo module an optional observer**

Use `WatchFileInbox.shared.pendingDirectory` for existing pending-file reads,
counts, and deletions. Replace `handleReceivedFile` with the
`WatchFileReceiverObserver` callback, which logs and sends
`onWatchFileReceived` only after persistence.

Import Sentry in `WatchMotionModule.swift` and add:

```ruby
s.dependency 'Sentry'
```

to the podspec.

- [ ] **Step 3: Run focused package tests**

Run:

```bash
cd packages/mobile/modules/watch-motion && swift test
```

Expected: all `WatchMotionTests` pass.

- [ ] **Step 4: Run affected Swift validation**

Run:

```bash
cd packages/mobile && swiftlint lint --strict modules/watch-motion
cd packages/mobile/modules/watch-motion && periphery scan --retain-public --disable-update-check --relative-results
```

Expected: both commands exit successfully.

- [ ] **Step 5: Review the diff against the issue**

Confirm:

- no persistence path depends on `WatchMotionModule`;
- the delegate synchronously persists before returning;
- module notification follows persistence and remains optional;
- Sentry receives final persistence errors;
- failed fallback copy leaves the source untouched;
- the lifecycle test creates the observer after delivery and sees pending data.

### Task 3: Publish and link the fix

**Files:**
- Review all changed files from Tasks 1–2.

- [ ] **Step 1: Run final fresh verification**

Run the focused Swift package tests, SwiftLint, and Periphery again and inspect
their exit codes.

- [ ] **Step 2: Commit and push**

Create an intentional conventional commit for issue #1715 and push the current
`issue-1715` branch.

- [ ] **Step 3: Open and link the pull request**

Open a PR against `main` whose body contains:

```text
Fixes #1715
```

Comment on issue #1715 with the PR URL so both directions are linked.
