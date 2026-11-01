# Climbing board and file providers

Access research checked **2026-11-01**. The implementations use the existing
[provider connections](adding-a-provider.md), [climbing graph](climbing-context.md),
and durable file uploads on web and iOS. Contract tests and PostgreSQL fixtures
verify the implementation; authenticated requests to real board accounts have
not been smoke-tested. See the [board account tests](../src/lib/climbing-board-account.integration.test.ts)
and importer tests beside each [provider](../src/providers/README.md).

## Available connections

| Source | Connection | Imported facts and limitations |
| --- | --- | --- |
| Kilter Board | Current account email/password | Native log IDs, dates, names, board angle, attempts, explicit completion and available grade/rating facts. Uses the current Kilter backend, independently of the retired Aurora Kilter service. |
| Tension Board | Aurora username/password | Separate native ascent/bid records, dates, angle, notes, explicit outcomes and available named ascent styles. |
| Grasshopper, Decoy, So iLL, Touchstone Board, Aurora Board | Each board's Aurora username/password | The same upstream protocol, with independent accounts, provider attribution, and host configuration. |
| Crimpd | Account email/password, or original logbook ZIP | Recorded workouts, climbing sets, board/angle/grade/notes, exact available tries and ascent flags, plus supported nonclimbing set facts. |
| 8a.nu / Vertical-Life | Account email/password, or 8a.nu logbook CSV | Native ascent IDs, four logbook categories, source dates, grades, notes and available attempt facts. Connected CSV imports require unique exact matches. |
| MoonBoard | Previously exported BoardLib CSV | Historical logbook rows. This connection does not fetch the current MoonBoard app. |

Board contracts come from the current [Kilter client](https://github.com/lemeryfertitta/BoardLib/blob/6943d6682431258a5bf6229f659ffaac61040652/src/boardlib/api/kilter.py),
[Aurora client](https://github.com/lemeryfertitta/BoardLib/blob/6943d6682431258a5bf6229f659ffaac61040652/src/boardlib/api/aurora.py),
and [Aurora's app directory](https://auroraclimbing.com/).
These are unofficial app protocols, rather than supported public integration
APIs. Native fields, pagination and deletion behavior are also documented in
[Boardsesh's wire types](https://github.com/boardsesh/boardsesh/blob/740844766aeff5bb5adc4536a13d34456cd00b4d/packages/aurora-sync/src/api/sync-api-types.ts).

### Board accounts

Open Settings → Data Sources and connect the desired board. Kilter uses the
current account; other boards use their Aurora **username**, which may differ
from an email address. Passwords are exchanged for per-user credentials and
are not retained by these providers; see the [Kilter client](../src/lib/kilter-board-client.ts)
and [Aurora client](../src/lib/aurora-board-client.ts).

Use an existing account after accepting its terms and privacy policy in the
board app. Aurora's observed sign-in request includes those acceptance flags
([upstream login implementation](https://github.com/boardsesh/boardsesh/blob/740844766aeff5bb5adc4536a13d34456cd00b4d/packages/aurora-sync/src/api/aurora-client.ts)).
Both Dofek clients display this prerequisite in the active connection form.

Kilter refresh tokens rotate through the existing encrypted token repository.
Aurora does not supply an expiry in the observed session response; its stored
far-future timestamp is a local opaque-session marker, not a vendor expiry
guarantee. Rejected sessions require reconnection. The implementation uses
concurrency one and daily scheduling without claiming an undocumented vendor
rate limit ([queue configuration](../src/jobs/provider-queue-config.ts)).

Kilter reads a complete logbook and reconciles removed entries only after a
validated successful fetch. Aurora's paginated sync is a delta protocol: missing
rows are retained, while explicit ascent tombstones are applied. Unsupported
numeric grade/attempt-code conversions stay raw. Aurora climb names and grade
labels remain unknown when they are absent from the user feed; Dofek does not
download the full proprietary climb catalogue merely to fill them in. See the
[account writer](../src/lib/climbing-board-account.ts) and
[upstream delta mapping](https://github.com/boardsesh/boardsesh/blob/740844766aeff5bb5adc4536a13d34456cd00b4d/packages/aurora-sync/src/sync/apply-user-logbook.ts).

Anonymous attempts expanded from a count do not inherit the named attempt's
completion. Without native per-attempt IDs or distinguishing facts, anonymous
siblings remain interchangeable when their last descriptive fact is cleared;
see the [source identity regressions](../src/db/climbing-log-sync.integration.test.ts).

No verified remote session-revocation contract is implemented for these new
board connections. Disconnect the board in Dofek before deleting the Dofek
account. The [erasure prerequisite](../src/account-erasure/remote-snapshot.ts)
fails before activation with that specific action, rather than claiming a
remote revocation succeeded.

## Filtering board climbs

In the existing climbing views, open **Filters → Board** on web or iOS.
**Board climbs** selects entries with recorded board metadata; **No board
recorded** selects entries without it, including records whose board context is
unknown. Both are selected by default, preserving the combined view. Clearing
both choices selects no entries; Clear filters restores the default. These
choices intersect with climbing type, setting, and other existing filters.
See the [shared filter contract](../packages/training/src/climbing-filters.ts)
and the [server projection](../packages/server/src/repositories/climbing-rock-observations.ts).

Selection uses each log's recorded metadata, so it also works for mixed-source
file imports. It does not infer board use from the provider or classify missing
metadata as ordinary gym bouldering. Counts and charts are filtered on the
server before aggregation, with unlogged activity time and sessions retained
when both board choices are selected; see the
[repository regressions](../packages/server/src/repositories/climbing-repository.integration.test.ts)
and [progression regressions](../packages/server/src/repositories/climbing-progression-repository.integration.test.ts).
Activity time still describes the matching recorded activities, rather than an
estimated duration for individual climbs; see the
[weekly-volume query](../packages/server/src/repositories/climbing-repository.ts).

## File exports

### Crimpd

Connect Crimpd in Settings → Data Sources with your account credentials.
Dofek stores renewable credentials per user and downloads the logbook ZIP for
scheduled and manual sync through the same [importer](../src/providers/crimpd/provider.ts).
The [client](../src/providers/crimpd/client.ts) follows the current
[Crimpd web application](https://my.crimpd.com/); independent server requests
verified renewal and export access on November 1, 2026. The tested account had
an empty history, so populated mapping is covered by export fixtures rather
than an owner-account smoke test. See the [research record](climbing-logbook-api-research.md).

Uploads remain available on the web provider detail screen and the mobile
provider card. Sync and uploads preserve manual climbing attachments and do
not interpret missing export rows as deletions; see the
[persistence tests](../src/providers/crimpd/provider.integration.test.ts).
Upstream authorization revocation is unverified: disconnect Crimpd in Dofek
before requesting account erasure, as enforced by the
[erasure prerequisites](../src/account-erasure/remote-snapshot.ts).

In Crimpd, choose Analytics → Export Log Data → Download, or Settings → Download
Logbook, then upload the original ZIP in Dofek. Crimpd documents
`workouts.csv`, `sets.csv`, and `observations.csv` in its
[official export reference](https://crimpd.com/docs/data-export/).

The importer joins workouts and sets by native `LOG_ID`, retaining set positions
as source identities. `ASCENT` describes a climb result independently of
`COMPLETE`, which describes completion of an exercise set. Empty cells remain
unknown, including when a reimport clears an earlier value. The
[parser](../src/providers/crimpd/parser.ts) preserves native raw set facts.

Crimpd's `DATE` is when the workout was logged. Dofek uses that recorded
occurrence as its structural activity timestamp, leaves the end unknown, and
does not convert estimated work/rest/total times into measured duration.
Workout rollups such as workload and aggregate grades are not ingested as
metrics. Resistance remains raw because the export mixes lifted weight with
added/assisted bodyweight load; fractional repetitions and the app's rating
scale are also not coerced into different canonical meanings. Profile
`observations.csv` values are not normalized by this importer. These limits
follow the [documented field semantics](https://crimpd.com/docs/data-export/)
and are exercised in the [import tests](../src/providers/crimpd/provider.integration.test.ts).

### 8a.nu / Vertical-Life

Connect your account in Settings → Data Sources. Scheduled and manual sync read
the shared Vertical-Life logbook using renewable per-user credentials. The
[client](../src/providers/eight-a/client.ts) reads bouldering, sport climbing,
indoor routes and indoor boulders until each category returns an empty page,
including projects, repeats and duplicates. Direct Node renewal and owner reads
were verified on November 1, 2026; the owner history was empty. Populated outdoor
responses supplied parser fixtures, while populated indoor behavior remains
unverified and indoor grade systems stay unknown. See the
[authentication and source evidence](climbing-logbook-api-research.md#vertical-life-mobile-client-verification)
and [shared logbook announcement](https://www.8a.nu/news/find-your-logbook-in-the-vertical-life-app).

Before the first native sync, every existing CSV occurrence must have a unique
exact match in the remote logbook. Dofek migrates those identities in place,
preserves attachments and attempts, and retains both payloads in the canonical
record. Once connected or native history exists, uploads only retain provenance
for uniquely matched records; they cannot overwrite native facts or add new
ascents. Edited, unmatched and ambiguous CSV rows fail atomically with an
actionable error. Add new ascents in Vertical-Life and sync them. Matching uses
the shared source kind, calendar date, name, location/sector/area/country, grade,
result, tries, comment, subtype, project flag, rating and recommendation. Country
codes are compared with English region names through the server's
[`Intl.DisplayNames`](https://tc39.es/ecma402/#sec-intl.displaynames.prototype.of).
Matching requires a known name, location and date. Nonempty CSV fields with no
verified API counterpart, such as height or repeat counts, block an automatic
initial match. Previously bound historical uploads must retain their complete
CSV payload; they cannot silently change unverified fields. See the
[resolver](../src/providers/eight-a/identity.ts) and
[database regressions](../src/providers/eight-a/provider.integration.test.ts).

Complete native syncs reconcile missing native occurrences without deleting raw
history or attachments. Failed or malformed fetches never retire records.
Upstream session revocation is unverified, so disconnect the source in Dofek
before requesting account erasure; see the
[lifecycle prerequisite](../src/account-erasure/remote-snapshot.ts).

Download the CSV through 8a.nu Profile Info → edit → Logbook Export, then upload
it to **8a.nu / Vertical-Life** in Dofek. The [official FAQ](https://www.8a.nu/faq)
documents ascent export, and the [shared logbook announcement](https://www.8a.nu/news/find-your-logbook-in-the-vertical-life-app)
explains Vertical-Life's relationship to the 8a.nu logbook. The parser follows a
[representative export fixture](https://github.com/edouardmisset/unified-climbing-projects/blob/main/src/domain/fixtures/8a-nu.fixture.ts).

Before account connection, the file has no native ascent/route IDs. Dofek identifies exact source rows by
content plus duplicate occurrence number, preserving repeated rows and stable
identity when unrelated rows move. An edited row becomes a distinct source
occurrence: the importer cannot safely infer which earlier row it replaced.
Zero/empty tries stay unknown. Location text alone does not establish indoor or
outdoor setting. See the [parser](../src/providers/eight-a/parser.ts) and
[reimport regression](../src/providers/eight-a/provider.integration.test.ts).

### Historical MoonBoard exports

Upload an existing **BoardLib logbook CSV** in the MoonBoard source. The parser
accepts the documented BoardLib fields, preserves grades and raw rows, and does
not convert `4+` or project status into an exact attempt count. Only an explicit
`is_ascent` flag establishes completion. See the
[BoardLib export contract](https://github.com/lemeryfertitta/BoardLib),
[MoonBoard source mapping](https://github.com/lemeryfertitta/BoardLib/blob/6943d6682431258a5bf6229f659ffaac61040652/src/boardlib/api/moon.py),
and [Dofek parser](../src/providers/moonboard/parser.ts).

All three file importers are additive and preserve manual activity attachments.
Absence from an uploaded file never proves a remote deletion. Malformed source
data is rejected with an actionable import error; unexpected storage failures
remain reportable failures. See the importer database tests and the
[import job](../src/jobs/process-import-job.ts).

## Remaining access requirements

| Source | Evidence | Requirement before implementation |
| --- | --- | --- |
| 27 Crags | [Official account JSON export](https://27crags-kb-05222019.instantdocsbase.com/help/can-i-export-my-data) exists; an export schema or representative file was unavailable. | A sanitized actual account export or vendor schema establishing IDs, dates, grades, attempts, and root structure. |
| Griptonite | [Official FAQ](https://griptonite.io/gyms/faq/) states no open API. Unauthenticated endpoint existence does not establish usable authorization or payloads. | Approved integration access or a verified personal export/authenticated data contract. |
| Current MoonBoard account sync | [Official announcement](https://eu.moonclimbing.com/News/post/moonboard-app-update-important-information) describes the API replacement; [current client investigation](https://github.com/milwil-2/boardlink/blob/main/docs/moonboard-api.md) does not establish working access. | A verified current logbook-read contract or supported export. |

These sources are not registered as nonfunctional connection cards. Before
adding them, verify the actual upstream record contract and exercise the same
owner-isolation, partial-fetch, known-to-unknown refresh, and reimport cases as
the implemented providers.
