# Consistent original FIT retention

The user approved consistent long-term original FIT retention after the hardware-metadata audit found transient Wahoo/manual imports alongside durable official Garmin delivery. Preserve full received FIT bytes so future extraction can recover messages the current parser does not consume.

## Approach and policy

Reuse the existing `ProviderArtifactStorage`, AWS SDK streaming upload and `IMPORT_R2_BUCKET`. New local FIT sources use streamed SHA-256 content identifiers beneath `provider-artifacts/<user>/<provider>/<hash>.fit`. Official Garmin delivery keeps its already-retained object and passes an explicit owned key to the shared importer, avoiding another durable copy. Changing original filenames or import identity inputs is outside this change.

The alternative of retaining transient `imports/` uploads would mix upload lifecycle with durable source retention and still miss provider downloads. A separate bucket or archive service would duplicate existing storage/deletion machinery. The existing prefix is the smallest complete implementation: [the configured lifecycle](../../../deploy/storage.tf) expires only `imports/`, and R2 supports [prefix-scoped lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

Every FIT reaching the shared importer must be archived successfully before decoding. Malformed and unsupported FIT files remain retained. Storage failures propagate and prevent decoding and success cleanup. Temporary local files and successful source uploads can still be removed after the durable copy exists.

Failure recovery remains inside the existing file/queue infrastructure. Provider downloads stage under a validated user/provider prefix with an exact import-payload sidecar; if archival fails, those pending bytes remain available for resync or operator reimport. Successful retention permits staging cleanup even if later decoding fails. Provider/account erasure also removes these owned pending prefixes. ZIP children persist their retained artifact key before parsing; an unretained child blocks parent source cleanup instead of becoming a terminal parsed-data error. Upload/dump workers and FIT children use the same outer provider lock as provider deletion, so active archive writes finish before prefix deletion completes.

Garmin ZIP entries with invalid accompanying activity summaries must still reach FIT processing without that invalid summary; keep the summary error and use any valid metadata in the FIT itself. Existing extraction/size safety limits remain. This policy covers FIT members that can be extracted, not complete source ZIPs or unreadable/oversized members.

Retained originals have no age expiry. Provider-data deletion removes the exact owned provider prefix; account erasure removes the whole owned user prefix. A retained archive is sufficient ownership evidence for provider deletion, including when parsing produced no canonical records. Disconnect and individual activity soft deletion keep their existing semantics.

## Boundaries and validation

No new dependencies, environment variables, bucket configuration, UI, download endpoint, backfill, or parser-field extraction. Web and mobile share the existing provider deletion API. Already-discarded originals cannot be recovered by this change.

Test exact bytes and content identity, archive-before-decode ordering, malformed/unsupported inputs, failure propagation, safe reuse of owned Garmin keys, import identity preservation, skipped ZIP entries, and archive-only provider deletion. Exercise the real S3 client through network-level MSW fixtures and the real native decoder where appropriate; keep database-dependent ownership behavior in executable database tests.
