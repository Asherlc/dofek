# FIT decoding

## Original-file retention

All current FIT input paths retain the complete original bytes before native
decoding through the [shared importer](../jobs/process-fit-file-import-job.ts)
and [provider artifact storage](../provider-artifact-storage.ts):

| Input path | Original-file retention |
| --- | --- |
| Official Garmin activity-file delivery | The [Garmin activity handler](../providers/garmin/activities.ts) archives the download first. The shared importer validates and reuses that owned object. |
| Wahoo, COROS and Suunto downloaded FIT | The [provider FIT staging path](../jobs/enqueue-fit-file-import.ts) retains the original before parsing. Local staging remains temporary. |
| Manual FIT upload | The original FIT is archived before decoding; the [upload import job](../jobs/process-file-upload-import-job.ts) can delete the transient source upload after success. |
| Garmin export ZIP | Each extractable FIT member is retained through the shared importer. The full export ZIP and extracted local files remain temporary. |

New local sources use
`provider-artifacts/{userId}/{providerId}/{sha256-of-file-bytes}.fit`. Reimporting
the same bytes under the same user/provider reuses that object; different bytes
under the same filename are retained separately. Existing official Garmin
objects keep their callback-derived identifiers. Archiving never changes
`originalPath`, which is also an input to existing import identities. See the
[storage implementation](../provider-artifact-storage.ts) and
[FIT external identity](external-id.ts).

Malformed and unsupported FIT files are retained too. An archive failure fails
the import before decoding. A Garmin FIT with an invalid companion summary
still proceeds using its own metadata, while preserving the summary error in
the [ZIP import result](../providers/garmin-dump.ts). Entries that cannot be
extracted within existing safety limits remain import failures; complete source
ZIPs are not part of the FIT archive.

If R2 retention fails for a provider download, the received bytes and exact
import payload remain on worker disk under
`JOB_FILES_DIR/provider-fit/{userId}/{providerId}/{sha256}/{logicalFilename}/`,
as `input.fit` and `import.json`. These are pending retry sources, separate from
the durable R2 archive. A resync of the same source reuses the pending path;
successful retention/import removes that source's directory. Provider/account
erasure removes the corresponding owned staging prefix even if queue discovery
is unavailable. The [staging boundary](../jobs/provider-fit-staging.ts) validates
ownership, and [provider FIT ingestion](../jobs/enqueue-fit-file-import.ts)
controls the lifetime.

For operator recovery after restoring R2 access, validate the adjacent
`import.json` with `fitFileImportJobDataSchema`, then submit it to the existing
`getFitFileImportQueue().add("fit-file-import", data)`. The queued processor
preserves the original owner/provider, original path and activity summary, and
cleans its owned pending source after retention and processing. The
[queue contracts](../jobs/queues.ts) and
[processor](../jobs/process-fit-file-import-job.ts) define this payload; operator
code must close queue resources when finished.

From a configured worker/repository environment, enqueue one pending source
without printing its payload:

```sh
fit_metadata_path='/absolute/path/to/import.json'
pnpm tsx -e '
import { readFile } from "node:fs/promises";
import { fitFileImportJobDataSchema, getFitFileImportQueue, closeAllQueueResources } from "./src/jobs/queues.ts";
void (async () => {
  try {
    const metadataPath = process.argv[1];
    if (!metadataPath) throw new Error("Pass the pending FIT import.json path");
    const data = fitFileImportJobDataSchema.parse(JSON.parse(await readFile(metadataPath, "utf8")));
    const job = await getFitFileImportQueue().add("fit-file-import", data);
    console.info(`Queued FIT recovery job ${job.id}`);
  } finally {
    await closeAllQueueResources();
  }
})();' "$fit_metadata_path"
```

ZIP children record their retained artifact key before decoding. If any child
cannot be retained, the parent keeps its extracted source and upload working
directory for retry instead of reporting a terminal parsed-data failure. Such
pending upload sources remain owned by the file-upload workflow and are removed
by successful retry or account erasure; the
[ZIP workflow](../jobs/process-garmin-dump-import-job.ts) and
[upload wrapper](../jobs/process-file-upload-import-job.ts) implement that
lifetime. Active upload/child archive writes share the provider-deletion lock in
the [worker boundary](../jobs/worker-queues.ts).

Retrying only a failed ZIP parent does not restart its failed children. Restore
archive access, then recover the failed FIT/batch work explicitly or submit a
fresh upload. Preserved source files provide recovery input; this change adds
no automatic background recovery scanner.

The configured R2 seven-day expiration applies to `imports/`, while Garmin's
`provider-artifacts/` prefix has no age-based rule in the
[storage configuration](../../deploy/storage.tf). Cloudflare documents
[prefix-scoped lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).
Provider-data deletion and account erasure remove the corresponding retained
provider artifacts through the
[deletion boundary](../jobs/provider-data-deletion-dependencies.ts). Owned
archives also qualify for [provider-data deletion](../../packages/server/src/repositories/provider-detail-repository.ts)
when parsing produced no canonical records. Disconnect and individual activity
soft deletion retain their existing behavior.

The storage interface can materialize an archived object for reprocessing. This
policy applies to files received after deployment; it cannot recover older
originals already removed by transient import paths.

The [metric-stream R2 archive](../../deploy/redpanda/metric-stream-r2-archive.connect.yml)
contains extracted event JSON, not original FIT bytes. It cannot recover FIT
messages discarded before ingestion. The original-file archive preserves those
bytes independently of which fields the current parser consumes.

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
