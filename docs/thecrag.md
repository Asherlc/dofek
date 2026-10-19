# theCrag

Dofek's [`thecrag` provider](../src/providers/thecrag.ts) reads one connected user's climbing logbook and
stores each ascent as a standalone `fitness.climbing_log_entry`. The integration
uses the existing personal-token connection flow on both web and mobile.

## Connect

1. Keep an active theCrag supporter subscription.
2. In theCrag, open Settings → API Keys and generate a personal API key.
3. In Dofek's data sources, choose **theCrag** and paste the key into
   **Personal API key (active supporter required)**.

theCrag requires supporter status both to issue a key and to use it. Keys can
expire; the public guide does not give a fixed lifetime. The connection form
links to the [official personal logbook API instructions](https://www.thecrag.com/en/article/logbookreadapi).
If theCrag rejects a saved key, restore supporter eligibility or generate a
replacement, then reconnect in Dofek.

Dofek treats HTTP 401 as a rejected key requiring reconnection. An unclassified
HTTP 403 is reported as blocked access and preserves saved credentials; it does
not prove the key has been revoked.

Keys are saved per Dofek user through the existing encrypted token storage.
There are no new deployment environment variables or application credentials.
Dofek does not ask for the user's theCrag password.

## Read contract

Requests use the production endpoint and the documented key header:

```http
GET https://www.thecrag.com/api/logbook/ascents?page=1
X-CData-Key: key=<personal-api-key>
```

The API accepts `page` and an optional `since` Unix-epoch timestamp for
ascents updated after that point. Its `data` response contains `account`,
`ascents`, `numberAscents`, `page`, and `perPage`. Each ascent has an ID and
creation/update epochs, dates, tick metadata, notes, and route context. Private
notes are included. See the [published request and response reference](https://www.thecrag.com/en/article/logbookreadapi).

## Sync and storage

Every sync reads the full paginated logbook, including scheduled syncs, so
removed ascents and edited historical ascents are discovered independently of
their climb dates. A sync validates the complete fetched batch before saving it
and reconciling missing ascents in one database transaction through the
[snapshot writer](../src/db/climbing-log-snapshot.ts).

The original ascent payload remains available in `raw.ascent`, and
`raw.accountId` identifies its source account. The payload retains provider IDs,
tick labels, historical markers, performance ratings, tags, pitch data, and
route ancestry. Verified route/ancestor IDs identify shared Climb and Area
objects. Published route grades and separately reported ascent grades retain
their owners. Source dates and notes belong to the log. Recorded gear style
and tick labels supply independent execution facts; advertised route protection
stays on the Climb. Catalogue pitch definitions and counts do not establish
tries. Without a reported attempt total, the log records one occurrence.
Missing method, board and angle remain unknown. See the
[adapter](../src/providers/thecrag.ts) and [model](climbing-context.md).

After a complete successful fetch, missing ascents receive a `providerAbsentAt`
timestamp. A valid empty logbook retires every previously imported source
ascent for that Dofek user and provider. Raw payloads, attempts, and attachments
remain stored; reappearing ascents restore their original records. Incomplete
pagination, invalid records, and fetch failures leave existing records intact.
See the [provider integration tests](../src/providers/thecrag-sync.integration.test.ts).

The [queue policy](../src/jobs/provider-queue-config.ts) uses daily polling and concurrency one. These settings reduce
request volume; they are not an upstream quota guarantee. theCrag documents
a weekly per-account budget without a numeric allowance in its
[personal API guide](https://www.thecrag.com/en/article/logbookreadapi). That
guide recommends incremental reads to minimize token usage; Dofek deliberately
uses full reads to detect upstream deletions, consuming more of that budget.

## Evidence and limitations

The implementation and fixtures target the published personal-endpoint
contract. An authenticated production response has not yet been verified;
unauthenticated research requests were blocked by Cloudflare. Passing fixture
tests establish Dofek's handling of that contract, not live-account access.

The [importer](../src/providers/thecrag.ts) recognizes supported rock, ice,
mixed, snow, hiking, scrambling and mountaineering classifications when source
styles establish them. theCrag supports additional valid disciplines
([Route Gear Styles](https://www.thecrag.com/en/article/styles)). If recorded
gear and route styles cannot establish a supported discipline, or conflict,
the entire batch stops without changing saved entries. No ascents are skipped,
so incomplete discovery cannot retire saved ascents. A top-rope tick
can still be classified when its route supplies a sport or trad style.

The reference names `date` and `logDate` as ISO-8601 values but does not
establish every live representation. It also lists `gradeAtom.type` without
defining its values or identifying a grading-system discriminator
([personal API reference](https://www.thecrag.com/en/article/logbookreadapi)).
Only valid `YYYY-MM-DD` source-date prefixes establish the normalized date.
Grade components retain source text; clear V-scale/YDS syntax and explicit
supported scale labels establish systems through the shared validator.
Bare numeric grades or `6a`/`6A` without a supported system label retain a null
system. theCrag's
[grade-system documentation](https://www.thecrag.com/en/article/gradesonthecrag)
shows why identical grade text can belong to different systems. The undefined
live semantics of `gradeAtom.type` remain an acceptance-check limitation.

The [importer](../src/providers/thecrag.ts) supports explicit textual scale
labels with colon syntax, including the following examples:

| Label | System | Supported example |
|-------|--------|-------------------|
| `FR` | French | `FR: 6a` |
| `FB` | Fontainebleau | `FB: 6A` |
| `AU` | Ewbank | `AU: 20` |
| `UIAA` | UIAA | `UIAA: 7` |
| `YDS` | Yosemite Decimal | `YDS: 5.10a` |
| `BLDV` | V-scale | `BLDV: V4` |
| `AID` / `AIDC` | Aid | `AID: A2`, `AIDC: C2` |
| `WICE` / `AICE` | Water / alpine ice | `WICE: WI3`, `AICE: AI3` |
| `MIXED` | Mixed | `MIXED: M4` |
| `IFAS` / `NCCS` | Alpine / commitment | `IFAS: AD`, `NCCS: III` |
| `UK` / `UKT` | British adjectival / technical | `UK: E1`, `UKT: 5a` |

The labels come from theCrag's
[grade-system documentation](https://www.thecrag.com/en/article/gradesonthecrag).
The prefixed examples describe Dofek's tested importer inputs; the personal
endpoint does not document that native `route.grade` values contain those
prefixes. They are not a verified `gradeAtom.type` mapping.

A first live acceptance check should confirm key issuance and supporter
eligibility, authenticated pagination, date representation, native grade
metadata, and an edited historical ascent or deletion appearing in a subsequent
full sync. Use a private fixture account and keep its key and personal
notes out of logs and shared test fixtures.
