# Climbing context

Climbing entries preserve where a climb was, its board and reported angle,
how it was climbed, and the recorded result. Activity details and unattached
tick suggestions expose the same context on web and mobile. The canonical
contract is defined in [the shared schemas](../packages/training/src/climbing-context.ts)
and [migration 0134](../drizzle/0134_climbing_context.sql).

## Canonical facts

| Field | Stored value |
| --- | --- |
| `location_path` | Ordered nodes from broadest to nearest, each with `name`, nullable `externalId`, and nullable `kind` (`destination`, `area`, `subarea`, or `gym`). Unknown hierarchy is `[]`. |
| `board` | Nullable `{ name, externalId }` describing the supplied layout/model or physical board. |
| `wall_angle` | Nullable `{ value, unit }`; units are `degrees` or null. Finite values with unknown units are retained. Known degrees are constrained to −90 through 90. |
| `climb_style` | Nullable method: `lead`, `top-rope`, `follow`, `solo`, or `aid`. Boulder discipline stays in `climb_type`. |
| `result_style` | Nullable recorded label, including unrecognized labels. |
| `attempt_count` | Nullable positive recorded count; a tick or failure label does not establish how many tries occurred. |

JSONB shapes are checked in PostgreSQL and at application boundaries. They
remain source snapshots rather than a separately reconciled place catalogue;
PostgreSQL recommends predictable JSON document structure in its
[JSON design guidance](https://www.postgresql.org/docs/current/datatype-json.html#JSON-DESIGN).
Provider IDs scope all external location/board IDs. The API's `context.providerId`
identifies the selected metadata source even when a deduplicated entry's display
identity or combined source label comes from another source. Metadata is selected
as a complete snapshot, not assembled from unrelated providers' IDs.

## Interpretation

Readers use permanent `fitness.v_climbing_entry`; providers write
`fitness.climbing_entry`. The view computes `location_name`, `lead`, `sent`,
`wall_angle_degrees`, and `ascent_type`. These are read-only projections with no
duplicate stored facts, following PostgreSQL's
[view semantics](https://www.postgresql.org/docs/current/sql-createview.html).

| Canonical fact | Derived interpretation |
| --- | --- |
| Method `lead` / `top-rope` | `lead = true` / `false`; follow, solo, aid, and missing methods yield null. |
| Onsight, Flash, Redpoint, Pinkpoint, Repeat, Send | Known send. The first five also supply the existing success qualifier. |
| Attempt, Not sent, Fell/Hung | Known unsuccessful result. Fell/Hung remains one combined label. |
| Frenchfree, unfamiliar label, missing result | Unknown interpreted send status; recorded labels remain visible. |
| Angle with `unit: "degrees"` | Available to degree filters and analytics, including zero. |
| Angle with `unit: null` | Stored/displayed as reported; unavailable to degree filters and analytics. |

Detailed attempt records retain their existing precedence over entry-level
outcomes/counts. A climbing method alone never implies a send. Exact labels and
opaque provider payloads remain available for provenance. Formatting expands
TR to “Top rope” and Fell/Hung to “Fell or hung”; an unverified angle displays
as `Wall angle: −20 (units unknown)`. Missing outcomes/counts remain explicit.

## Provider coverage

| Source | Location | Board and angle | Method and result |
| --- | --- | --- | --- |
| Kaya API | Destination → area → subarea with IDs/roles, or climb/ascent/session gym fallback. | Climb board reference and signed integer angle; unverified units remain null. | Route lead boolean maps lead/top-rope. Ascent labels are preserved; attempted-climb feed records Attempt. Nullable recorded counts are retained. |
| Kaya CSV | Exported gym name with unknown ID. | Not supplied by the checked export. | Ascent label and recorded count; absent counts stay null. |
| Mountain Project | Complete exported path split into ordered names; IDs/roles unknown. | No dedicated board/angle field in the checked tick export. | Style records method, Lead Style records route result, Style records boulder result. Total attempts unknown. |
| OpenBeta | Full path names paired with ancestor UUIDs when aligned; known parent fallback. | No dedicated board/angle field in the checked schemas. | Style and attempt type preserved independently. Total attempts unknown. |

Evidence and remaining omissions are in the [Kaya audit](kaya.md#observed-location-and-angle-values),
[Mountain Project audit](mountain-project.md#climbing-style-and-result-coverage),
and [OpenBeta audit](openbeta.md#location-angle-and-board-coverage). They identify
the observed application responses and official schema sources. Kaya's public
examples include outdoor `angle: -20` and board angles `25`, `40`, `45`, and
`50`; the reviewed source does not establish units or reference direction.
Do not infer degrees or a provider-independent destination/area/subarea model
from those values or another provider's deeper location path.

## Existing records

Migration 0134 converts the four legacy columns in place and adds nullable
board metadata. It retains entry IDs, ownership, source identity, associations,
dates, tombstones, grades, raw payloads, and individual attempt rows. Existing
Mountain Project location strings become ordered paths; other legacy labels
become a single known node until re-sync supplies more detail. Legacy degree
angles keep `unit: "degrees"`. Raw method/result labels take precedence over
generic legacy lead/send flags. Previously inferred Mountain Project/OpenBeta
counts and CSV counts without a recorded raw value become null; recorded Kaya
counts remain. See the executable
[conversion regression](../src/db/climbing-context-migration.integration.test.ts).

The journal preserves the already deployed Kaya migration's identity and orders
the Apple Health migration after it. Both historical SQL files are unchanged.
The context conversion also removes the obsolete paired count/outcome constraint
if it remains present. Executable [upgrade-history tests](../src/db/climbing-migration-order.integration.test.ts)
verify both applied histories and a repeat run through the
[canonical migrator](../src/db/postgres-migrator.ts).

## Maintenance cutover

This is a coordinated application/schema release. Release approval must cover
the reviewed commit, a maintenance window, and the provider refresh's actual
fetch scope described below.
PostgreSQL column type changes take locks and can rewrite table data; consult
[ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html).
An image rollback after conversion cannot restore the old column contract.

Before requesting release approval:

1. Require the reviewed commit's tests, integration tests, mutation checks,
   builds, and required CI gates. Record its immutable image tag/digest.
2. Verify backup freshness and a successful isolated restore using the
   [backup/recovery runbook](database-backup-recovery-runbook.md). Fresh object
   metadata alone does not establish recoverability. Record evidence privately.
3. Record table size/counts and a private pre-cutover inventory of entry IDs,
   source IDs, associations, dates, tombstones, grades, and attempt IDs. Recheck
   size immediately before migration. A read-only size query is:

   ```sql
   SELECT count(*) AS entries,
          pg_size_pretty(pg_total_relation_size('fitness.climbing_entry')) AS size
   FROM fitness.climbing_entry;
   ```

4. Inventory every running application-image process. `web` reads and can
   attach/import entries; `worker` runs imports/syncs; `analytics-worker` and
   `processing-reconciliation` may schedule or read related work. Include
   outstanding one-shot sync/import/migration containers and CLI processes.
   Record desired service replica counts before quiescence.
5. Review the [release workflow](../.github/workflows/deploy-web-stack.yml)
   against the [deployment runbook](../deploy/README.md#release-unit-important).
   Its dependency apply keeps old web replicas alive before migration. The
   standard rolling path alone does not satisfy this cutover: the approved
   operator procedure must keep old readers/writers stopped throughout the
   column conversion, without a later stack apply restoring them early.
   Stage the new image and required secret files before the window. Inspect
   actual PeerDB mappings and apply the existing CDC gates if this table is
   mirrored; do not assume it is excluded.

During the approved window:

1. Stop new traffic/import submissions and drain active sync/import jobs.
   Quiesce the inventoried old processes through the existing Docker context;
   verify zero old tasks and no active table writers before migrating. Keep
   backups, PostgreSQL, Redis, and the other infrastructure available.
2. Run the canonical migration command from the staged image with the release's
   network/secrets, as specified in the deployment runbook. The migrator wraps
   pending SQL migrations transactionally; verify completion and the new view.
3. Resume only the matching application image. Restore recorded desired replica
   counts and run the existing health, CDC, and consumer-convergence gates.
   Verify details, suggestions, summaries, progression, and degree filters.
4. Compare the private inventory before any re-sync; require unchanged identities
   and detailed attempts. Verify old stored scalar columns were replaced, shape
   constraints are present, and known zero degrees/unknown units read correctly.
5. If conversion fails, keep traffic quiesced and confirm transaction rollback
   before resuming the old image. If conversion succeeds but the new application
   cannot run, fix forward or use the verified recovery procedure with writes
   still quiesced. Do not restart old binaries against the converted schema.

## Provider refresh and verification

After the matching release is healthy, enqueue provider refreshes through the
existing job API. Use an approved user, provider, and date window, with approval
covering the provider's actual fetch scope described below. The window builder
uses inclusive UTC calendar dates as implemented by
[the window builder](../src/jobs/sync-job-window.ts). For example, from a trusted
operator process inside the matching image:

```typescript
import { enqueueSyncJob } from "./src/jobs/enqueue-sync-job.ts";
import { syncJobDataFromTriggerInput } from "./src/jobs/sync-job-window.ts";
import { closeAllQueueResources } from "./src/jobs/queues.ts";

const providerId = "kaya";
const userId = "<approved-user-id>";
try {
  const job = await enqueueSyncJob(providerId, {
    userId,
    providerId,
    origin: "user",
    ...syncJobDataFromTriggerInput({ sinceDate: "2026-09-29", untilDate: "2026-09-29" }),
  });
  if (!job) throw new Error("The requested provider refresh was not queued.");
  console.log({ jobId: job.id });
} finally {
  await closeAllQueueResources();
}
```

The current [Kaya importer](../src/providers/kaya-sync.ts) filters session starts
by `since` and does not enforce `until`. The example therefore refreshes that
day and newer sessions; approve that full scope before running it. Mountain
Project and OpenBeta retain their full-list provider reconciliation semantics;
a date window does not turn
their endpoint into a partial export. Do not prune unrelated ticks to simulate
a bounded fetch. CSV metadata requires re-importing an export with the matching
provider. Check job completion, sync errors, record counts, context source IDs,
and the known/unknown method, result, count, and angle cases. Successful syncs
already invalidate user query caches through
[the sync processor](../src/jobs/process-sync-job.ts); details/suggestions also
use new versioned keys. Reload the matching web/mobile bundle before checking
rendered context. If no OpenBeta account is connected, report fixture coverage
separately from live account verification.
