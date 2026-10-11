# theCrag

Dofek's [`thecrag` provider](../src/providers/thecrag.ts) reads one connected user's climbing logbook and
stores each ascent as a standalone `fitness.climbing_entry`. The integration
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

The first sync and explicit manual/full syncs read the full paginated logbook.
Later scheduled syncs use the connected account's newest imported update epoch,
with a one-second overlap, to request new and edited ascents. The cursor follows
source update time, so an edited historical ascent can arrive independently of
its climb date. A sync validates the complete fetched batch before saving it in
one atomic database statement.

The original ascent payload remains available in `raw.ascent`, and
`raw.accountId` identifies its source account. The payload retains provider IDs,
tick labels, historical markers, performance ratings, tags, pitch data, and
route ancestry. Route names, source date prefixes, supplied ancestor paths,
and recorded tick results populate the existing climbing-entry model. Notes
remain in the raw payload. Sport/trad gear style can identify route protection,
but does not establish a climbing method. Missing method, attempt counts, board,
and angle remain unknown. The provider creates no synthetic activities and
stores no provider-estimated energy expenditure.

Dofek does not infer that an ascent was deleted when it is absent from an
incremental response. This initial integration provides no upstream-deletion
reconciliation.

The [queue policy](../src/jobs/provider-queue-config.ts) uses daily polling and concurrency one. These settings reduce
request volume; they are not an upstream quota guarantee. theCrag documents
a weekly per-account budget without a numeric allowance in its
[personal API guide](https://www.thecrag.com/en/article/logbookreadapi).

## Evidence and limitations

The implementation and fixtures target the published personal-endpoint
contract. An authenticated production response has not yet been verified;
unauthenticated research requests were blocked by Cloudflare. Passing fixture
tests establish Dofek's handling of that contract, not live-account access.

The reference names `date` and `logDate` as ISO-8601 values but does not
establish every live representation. It also lists `gradeAtom.type` without
defining its values or identifying a grading-system discriminator
([personal API reference](https://www.thecrag.com/en/article/logbookreadapi)).
Only valid `YYYY-MM-DD` source-date prefixes and supported, identifiable grade
systems are imported. Ambiguous dates or grades stop sync with an explicit
error and leave saved entries unchanged. Clear V-scale/YDS grades and explicit
supported system labels are validated through Dofek's shared grading library.
Bare numeric grades or `6a`/`6A` without a supported system label cannot establish
their system. theCrag's
[grade-system documentation](https://www.thecrag.com/en/article/gradesonthecrag)
shows why identical grade text can belong to different systems. The undefined
live semantics of `gradeAtom.type` remain an acceptance-check limitation.

The [importer](../src/providers/thecrag.ts) currently supports six explicit
textual scale labels with colon syntax, in addition to clear V-scale and YDS
values:

| Label | System | Supported example |
|-------|--------|-------------------|
| `FR` | French | `FR: 6a` |
| `FB` | Fontainebleau | `FB: 6A` |
| `AU` | Ewbank | `AU: 20` |
| `UIAA` | UIAA | `UIAA: 7` |
| `YDS` | Yosemite Decimal | `YDS: 5.10a` |
| `BLDV` | V-scale | `BLDV: V4` |

The labels come from theCrag's
[grade-system documentation](https://www.thecrag.com/en/article/gradesonthecrag).
The prefixed examples describe Dofek's tested importer inputs; the personal
endpoint does not document that native `route.grade` values contain those
prefixes. They are not a verified `gradeAtom.type` mapping.

A first live acceptance check should confirm key issuance and supporter
eligibility, authenticated pagination, date representation, native grade
metadata, and an edited historical ascent appearing in a subsequent
incremental read. Use a private fixture account and keep its key and personal
notes out of logs and shared test fixtures.
