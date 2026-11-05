# Pulsar foundation qualification

This checkpoint adds isolated infrastructure and native storage tests only.
Production remains unchanged. It does not include CDC replacement, analytics
activation, publisher cutover, archive conversion or production configuration.

The repeatable-payload correction was tested against actual Cloudflare R2 using
a separately scoped qualification bucket; the immutable
[corrected native offloader record](https://github.com/Asherlc/dofek/blob/ee7350f79/docs/pulsar-qualification.md#corrected-native-offloader-evidence)
records upload and remote reads, host source compilation, upstream tests and
packaging, and distinguishes those artifacts from a normal Docker source build.
The patch is maintained locally and is not a claim of stock R2 compatibility.

The standalone [source-build workflow](../.github/workflows/pulsar-source-build.yml)
now defines the repeatable Docker source-build regression: ARM, a verified 4 GiB
memory and memory-plus-swap limit on the
[container builder](https://docs.docker.com/build/builders/drivers/docker-container/),
no imported host NAR and no cached build layers. The
[Dockerfile](../deploy/pulsar/Dockerfile) runs the affected upstream test class,
both style checks and NAR packaging with retries disabled, then copies that NAR
into the broker image. It runs independently of the existing Test Gate and does
not run services, publish images or use R2 credentials. Commit-specific success
must be established by its [workflow runs](https://github.com/Asherlc/dofek/actions/workflows/pulsar-source-build.yml);
the [ARM source-build job](https://github.com/Asherlc/dofek/actions/runs/41993332932/job/127130525556)
passed at commit `7f98465d7330c554d5f71364cab29aff325e0f0c`. That cold build
compiled and packaged the NAR, ran both style checks, then executed the selected
upstream tests in a separate RUN step under the same 4 GiB limit. The
[tested Dockerfile](https://github.com/Asherlc/dofek/blob/7f98465d7330c554d5f71364cab29aff325e0f0c/deploy/pulsar/Dockerfile)
ends compiler/style process lifetimes before starting the test JVM; it changes
no heap, worker, retry or test-selection settings.

The historical, pre-PR [native evacuation ARM job](https://github.com/Asherlc/dofek/actions/runs/41871869660/job/126721886208)
passed at commit 10735959f in 135.687 seconds, within its 300-second bound and
without retries. It verified surviving payloads, replacement ensembles,
old-storage-offline reads, restart and new writes, and marker scans. The CI
fixture is retained here with the dedicated native test project.
That historical run does not qualify a later commit. The extracted fixture
also passed the [PR ARM job at commit 3a320e12c](https://github.com/Asherlc/dofek/actions/runs/41974906401/job/127072892431).
Subsequent fixture changes must pass that required job again before merge.

The subsequent [local stable-endpoint lifecycle result](https://github.com/Asherlc/dofek/blob/ee7350f79/docs/pulsar-qualification.md#november-5-stable-endpoint-lifecycle-passes)
also passed mixed-ledger expiry/offload/removal, exact surviving-data reads
before and after broker/replacement restarts, and fixture cleanup. That model
used a stable Compose endpoint; it does not validate Swarm addressing.

These results qualify local mechanisms, not production fit.
Physical storage isolation, host memory/disk,
stable production addressing, metadata restore, large-account erasure, archive
preservation and sealed cutover remain release gates. Retain source data and
production holds until their own restoration decision.

The source patch preserves the [pinned native offload layout](https://github.com/apache/pulsar/blob/v5.0.1/tiered-storage/jcloud/src/main/java/org/apache/bookkeeper/mledger/offload/jcloud/impl/BlobStoreManagedLedgerOffloader.java).
Offloaded data is not a substitute for metadata recovery; see [Pulsar tiered storage](https://pulsar.apache.org/docs/5.0.x/tiered-storage-overview/).
