# FIT decoding

## Original-file retention

Original files and extracted metric events have different retention paths:

| Input path | Original-file retention |
| --- | --- |
| Official Garmin activity-file delivery | The [Garmin activity handler](../providers/garmin/activities.ts) saves the original in [provider artifact storage](../provider-artifact-storage.ts) before parsing. |
| Wahoo downloaded FIT | The [Wahoo persister](../providers/wahoo/activity-persister.ts) uses temporary local [FIT staging](../jobs/enqueue-fit-file-import.ts), which is removed after processing. |
| Manual FIT or Garmin export ZIP upload | The [upload import job](../jobs/process-file-upload-import-job.ts) deletes the source upload after success; extracted files are temporary. |

The configured R2 seven-day expiration applies to `imports/`, while Garmin's
`provider-artifacts/` prefix has no age-based rule in the
[storage configuration](../../deploy/storage.tf). Provider-data deletion and
account erasure remove the corresponding retained provider artifacts through
the [deletion boundary](../jobs/provider-data-deletion-dependencies.ts).

The [metric-stream R2 archive](../../deploy/redpanda/metric-stream-r2-archive.connect.yml)
contains extracted event JSON, not original FIT bytes. It cannot recover FIT
messages discarded before ingestion. Raw device observations are retained by
the activity hardware importer, but that does not imply complete raw-file
retention for every input path.

Dofek decodes FIT files with a separate C++ executable built from Garmin's official
[FIT C++ SDK](https://github.com/garmin/fit-cpp-sdk). The native project lives in
[`native/fit-decoder`](../../native/fit-decoder/README.md) and uses CMake plus manifest-mode vcpkg.

## Data flow

1. The native decoder validates the complete file in a metadata-only first pass. It reports the
   FIT file type, first raw `file_id` (or `null`), and activity session without retaining record
   messages.
2. The Node adapter classifies the file as an activity or weight file and initializes the
   corresponding database writes.
3. The decoder makes a second pass and emits newline-delimited JSON batches bounded to 250
   messages and 512 KiB. Raw `device_info` messages stream as `devices` batches, preserving repeated
   observations and their order alongside record/weight batches.
4. Node validates and persists one batch, then writes `continue` to the child process. The decoder
   does not resume until it receives that acknowledgement.

This protocol bounds both native and JavaScript working sets independently of the total number of
records in a file. Node's standard child-process streams provide the process boundary and pipes;
see the official [`child_process.spawn()` documentation](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options).

Consumers receive the raw `file_id` through `FitStreamMetadata.fileId` and raw device observations
through the required asynchronous `onDeviceInfoBatch(messages)` callback. These raw fields retain
the SDK's snake-case names and numeric enums. The final `messageCount` includes devices plus
records/weights. The adapter waits for every callback before acknowledging its batch; see the
[adapter implementation](stream-decoder.ts) and [native protocol](../../native/fit-decoder/README.md#protocol).
Garmin distinguishes the file creator from device observations in its
[activity file specification](https://developer.garmin.com/fit/articles/file-types/activity.html).

## Key files

- `stream-decoder.ts`: protocol validation, process lifecycle, acknowledgement backpressure, and
  activity/weight normalization.
- `parser.ts`: pure normalization of already-decoded session and record fields.
- `records.ts`: conversion from normalized FIT records to provider-agnostic metric rows.
- `fixtures/`: non-user FIT fixtures used by native and TypeScript tests.

The decoder has a 120-second idle timeout. A malformed file, invalid protocol message, oversized
native message, or stalled child process fails the import instead of relaxing the memory bound.
Providers that download FIT files stage them in the shared job-files directory and wait on the
same `fit-file-import` queue used by uploaded Garmin dumps. The import job owns decoding, activity
replacement, retry classification, and cleanup of provider-staged files.
