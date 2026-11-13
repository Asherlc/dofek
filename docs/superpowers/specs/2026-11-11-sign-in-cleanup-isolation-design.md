# Sign-in during native sensor cleanup

The operator approved this direction on November 11: finish sign-in after old
credentials are cleared while sensor cleanup continues on its own serial queue.
Capture/uploads remain fenced until cleanup succeeds. Account deletion retains
its completion gate. All unexpected failures remain reportable.

The current signed-device operation
[0037204F-423A-4FE2-A507-74041E55AB45](https://east-bay-software.sentry.io/explore/logs/?project=4511073386627073&logsQuery=operationId%3A0037204F-423A-4FE2-A507-74041E55AB45)
stops at `store_delete_samples`. Its 6.27 GB database passes `quick_check` and
contains 13,944,095 samples; one local DELETE/ROLLBACK took 50.04 seconds.

## Approach and constraints

Use stock [Expo AsyncFunction queue dispatch](https://docs.expo.dev/modules/module-api/#asyncfunction)
with one module-owned serial queue for the six disk-backed WHOOP bridge calls.
This prevents WHOOP storage from occupying Expo's shared async queue and orders
`disableUploads` before subsequent `configureUpload` calls. The destructive
`purgeAccountState` call shares that FIFO, holding its queue item through the
store mutation or failure latch so already-dispatched configuration cannot
overtake erasure. Diagnostics may wait on this queue without blocking unrelated
native modules.

Serialize credential deletion before replacement credentials, but await native
cleanup separately. `clearSessionToken` still awaits cleanup and reports native
and credential failures; late cleanup must never clear a replacement session.
Failed native cleanup must leave capture suspended and block subsequent upload
configuration until an explicit successful cleanup. Preserve erasure leases,
native generations, task cancellation and late-ack rejection.

The fence must also survive an app restart. Before releasing credential
persistence, write one opaque cleanup-intent identifier to the existing
[SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/). Unknown
pending intent after cold start, or unreadable intent, blocks WHOOP configuration while authenticated navigation can
finish. Clear it only after successful cleanup, comparing its identifier under
the existing persistence serialization so an older completion cannot clear a
newer intent. A failed intent write must prevent replacement credential adoption.
Native capture begins suspended until allowed configuration succeeds. This adds
no automatic purge retry or recovery scheduler.

A successfully written intent known in the current JavaScript lifetime allows
replacement configuration into the native FIFO. Snapshot that live identifier
before reading storage so successful concurrent clearing does not reject valid
initialization. Disable and erasure purge synchronously invalidate configuration
calls still awaiting that read, preventing retired credentials from dispatching
after cleanup. If intent writing fails, retain the old credential completion
barrier for that failure path; report the failure and forbid replacement adoption
if native cleanup also fails. Ordinary successful intent writing releases
credentials independently of bulk purge.

An in-memory error alone cannot cover queued work that never starts, or a purge
that rolls back when the process exits: [SQLite transactions](https://www.sqlite.org/lang_transaction.html)
preserve the old same-account binding, whose configuration otherwise retains the
queue. The intent therefore precedes replacement persistence rather than being
written inside native purge.

## History and alternatives

[PR #3258](https://github.com/Asherlc/dofek/pull/3258) added the existing wait
when cleanup became asynchronous; its safety purpose must survive this change.
The new queue-ordering and failure tests replace that guarantee rather than
restoring the earlier synchronous implementation. No dedicated-queue revert was
found in the fetched history for the affected paths.

Keeping login behind the whole purge retains the observed stall. Replacing or
resetting the database adds a storage migration and erasure recovery machinery;
the healthy database does not justify that change. Detached cleanup without an
observable result fails the reporting and account-isolation requirements.

## Acceptance

Tests first demonstrate unrelated native work and replacement login completing
while cleanup is blocked. Native configuration cannot overtake cleanup; failure
keeps capture suspended. Existing completion/error, old-owner and erasure tests
remain valid. No dependency upgrade, retry, timeout or production release is part
of this approval. Signed-device acceptance is required before issue closure.
Restart tests retain pending intent across fresh module instances, block
same-account configuration/capture, and preserve ordinary restart durability
when no cleanup is pending.
