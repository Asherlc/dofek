# FIT decoding

Dofek decodes FIT files with a separate C++ executable built from Garmin's official
[FIT C++ SDK](https://github.com/garmin/fit-cpp-sdk). The native project lives in
[`native/fit-decoder`](../../native/fit-decoder/README.md) and uses CMake plus manifest-mode vcpkg.

## Data flow

1. The native decoder validates the complete file in a metadata-only first pass. It reports the
   FIT file type and activity session without retaining record messages.
2. The Node adapter classifies the file as an activity or weight file and initializes the
   corresponding database writes.
3. The decoder makes a second pass and emits newline-delimited JSON batches bounded to 250
   messages and 512 KiB.
4. Node validates and persists one batch, then writes `continue` to the child process. The decoder
   does not resume until it receives that acknowledgement.

This protocol bounds both native and JavaScript working sets independently of the total number of
records in a file. Node's standard child-process streams provide the process boundary and pipes;
see the official [`child_process.spawn()` documentation](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options).

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
