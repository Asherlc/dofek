# WatchConnectivity Durable File Receipt Design

## Goal

Persist every file delivered by the iPhone-side `WCSessionDelegate` before the
delegate callback returns, even when Expo has not created `WatchMotionModule`.
JavaScript notification is best-effort and must never gate persistence.

Apple places a received `WCSessionFile` in a temporary directory and deletes it
after `session(_:didReceive:)` returns unless the delegate moves it
synchronously to permanent storage. See
[Apple's `WCSessionFile.fileURL` documentation](https://developer.apple.com/documentation/watchconnectivity/wcsessionfile/fileurl).

## Root Cause

`WatchSessionDelegateHolder` is process-wide, but it forwards received files
through a weak `WatchMotionModule` reference. `WatchMotionModule` currently owns
the pending directory and performs the move. When the weak reference is nil,
the delegate logs that the file will be lost and returns without persisting it.

The current move fallback also uses `try?` for both copy and source deletion.
Consequently, a failed copy can still be followed by source deletion.

## Architecture

Add two Foundation-only types to `WatchMotionLib`:

- `WatchFileInbox` owns the pending-directory URL and synchronous persistence.
  It moves the received file into the pending directory. If the move fails, it
  copies the file and leaves the system-managed source untouched.
- `WatchFileReceiver` owns a `WatchFileInbox`, accepts received file URLs, and
  reports final persistence errors. It holds only a weak optional observer for
  post-persistence notification. An `NSLock` synchronizes observer attachment
  on the module lifecycle thread with reads from the WatchConnectivity
  background callback.

`WatchSessionDelegateHolder` strongly owns the shared receiver. Its
`session(_:didReceive:)` implementation calls the receiver synchronously
without consulting the Expo module. `WatchMotionModule` uses the same shared
inbox for pending-file operations and attaches as the receiver's optional
observer when Expo creates it.

The receiver's production error reporter calls `SentrySDK.capture(error:)`.
The podspec declares the existing native Sentry pod as a direct dependency so
reporting cannot silently compile out of the iOS module.

## Data Flow

1. WatchConnectivity calls the process-level delegate on its background thread.
2. The delegate passes the temporary URL and metadata to `WatchFileReceiver`.
3. `WatchFileInbox` creates the pending directory and synchronously moves the
   file to a UUID-named pending path.
4. If move fails, the inbox copies to the pending path and leaves cleanup of
   the system-managed temporary source to WatchConnectivity.
5. If both persistence paths fail, the receiver reports the error to Sentry and
   leaves the received source untouched for the remainder of the callback.
6. After successful persistence, the receiver optionally notifies the attached
   `WatchMotionModule`, which emits `onWatchFileReceived`.
7. When Expo creates the module later, it reads the same shared inbox and sees
   files persisted before module creation.

## Testing

Add native Swift lifecycle coverage to `WatchMotionTests`:

- Deliver a temporary file through `WatchFileReceiver` with no module observer
  attached, construct and attach the module-facing observer afterward, and
  verify the file is present in the shared pending inbox with unchanged bytes.
- Make the pending path impossible to create, deliver a file, and verify the
  injected error reporter is called while the received source file remains.
- Force move failure with successful copy and verify the destination bytes and
  retained source, then force both operations to fail and verify both errors
  are reported without deleting the source.
- Attach an observer before receipt and verify the complete destination file
  is readable from inside the notification callback.

Run the tests before production changes to prove the lifecycle case fails
because the new process-owned receiver does not yet exist. Then implement the
minimum production code and rerun the full `watch-motion` Swift package suite.

## Scope

This change does not alter Watch transfer scheduling, JavaScript sync behavior,
file parsing, acknowledgement semantics, or either platform's UI. A paired
physical iPhone and Apple Watch remain necessary for end-to-end
WatchConnectivity delivery validation.
