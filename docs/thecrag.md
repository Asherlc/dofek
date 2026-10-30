# theCrag

Dofek's [theCrag provider](../src/providers/thecrag/provider.ts) imports public
ticks automatically from an account's ascent feed and public ascent pages.
It uses a public username, without a supporter subscription, API key, login,
or browser process. Each ascent becomes a standalone climbing log entry; the
existing [queue policy](../src/jobs/provider-queue-config.ts) polls daily with
one concurrent sync job.

## Connect

In Data Sources, choose **theCrag**, enter your username or
`https://www.thecrag.com/climber/<username>` in **theCrag profile URL or
username**, and connect. The same public-profile form is used on web and mobile.
The public logbook URL `https://www.thecrag.com/ascents/by/<username>` is also
accepted.
The provider verifies an exact username match through the public climber lookup
and saves the resolved numeric account ID in the existing per-user encrypted
identity repository. See [the provider](../src/providers/thecrag/provider.ts).

Older personal-key connections require reconnection. Revoke the old key in
theCrag's Settings → API Keys before replacing or disconnecting the old
connection; Dofek cannot revoke that key on your behalf. The owner-managed
key settings are described in the [personal API guide](https://www.thecrag.com/en/article/logbookreadapi).
The [erasure prerequisite](../src/account-erasure/remote-snapshot.ts) blocks
account deletion while saved legacy key credentials remain connected. A new
public identity has no remote authorization to revoke. Existing climbing data
and user-selected workout attachments remain stored.

This classification describes the currently saved connection. Reconnecting or
disconnecting Dofek does not revoke an older owner-managed key or provide proof
that it was revoked. The [token repository](../src/db/tokens.ts) stores current
credentials rather than a historical revocation ledger; complete the manual
theCrag revocation step before replacing or removing a legacy key connection.

## Public read path

1. Resolve the username using `/api/lookup/climber?search=<username>`.
2. Read `/feed/ascents/climber/<account-id>` and its `rel="next"` links.
3. Extract ascent IDs from event HTML and fetch `/ascent/<ascent-id>`.

The feed route is recorded in theCrag's
[maintainer discussion](https://github.com/theCrag/website/issues/1997).
The [parser](../src/providers/thecrag/public-parsing.ts) validates Atom XML,
account ownership, ascent and route IDs, recorded climb dates, methods and
pagination. All discovered details must validate before any records are saved.
Cloudflare blocks, nonpublic redirects and malformed or failed pages surface
errors and preserve existing entries; they do not prove login is required.

For non-200 responses, the [provider](../src/providers/thecrag/provider.ts)
reports Sentry tags `phase=public_request` and `requestKind` (`profile_lookup`,
`feed`, or `ascent`), with `httpStatus` in extra data. For 3xx responses,
`redirectTarget` classifies the Location header as `thecrag` (the exact public
HTTPS origin), `thecrag_processing` (the exact
`https://swamp.processing.thecrag.com` origin), `external`, `invalid`, or
`missing`. Relative locations resolve against the requested URL. These are
diagnostic categories, not permitted redirect destinations: requests still
never follow redirects. Raw locations, arbitrary hostnames, paths, queries,
credentials and response bodies are excluded from this diagnostic.

For a public-request 3xx failure, compare the destination status using the
deployed transport before proposing a redirect-policy change. On 2026-10-29,
production lookup/feed probes returned 200, but the feed's ascent page
redirected to the processing origin and that destination returned 403; see the
[incident record](production-incident-baseline.md#2026-10-29--thecrag-ascent-requests-redirected-to-a-forbidden-host).
Compare the same public ascent from the production host and workstation before
changing transport: on October 30, private Firefox and workstation native/Linux
Impit probes succeeded while both the deployed transport and an isolated
production-image container returned 302. Local success does not establish
production recovery; see the [recurrence evidence](production-incident-baseline.md#2026-10-30--thecrag-connection-warning-recurrence).

The provider-local [HTTP transport](../src/providers/thecrag/public-transport.ts)
uses Impit 0.14.7 with the tested `chrome` networking profile through Dofek's
shared rate-limit, diagnostic and two-minute deadline boundary. TLS verification
stays enabled; no proxy or cookie jar is configured. Impit ships native ARM64
musl binaries and does not launch Chrome
([Impit documentation](https://apify.github.io/impit/js/)). HTML parsing uses
Cheerio without script execution or external resource loading
([Cheerio documentation](https://cheerio.js.org/docs/intro/)).

## Storage and limitations

Feeds describe events, including grouped ascents, rather than an authoritative
current logbook. Historical discussions describe summarized groups
([upstream example](https://github.com/theCrag/website/issues/1837#issuecomment-71587804)).
Complete historical coverage and deletion events are not guaranteed. Dofek
therefore [upserts observed entries](../src/providers/thecrag/persistence.ts)
without marking unobserved records absent, including when the feed is empty.
This path imports public ticks; it cannot fetch private notes or guarantee a
complete historical backfill.

The [parser](../src/providers/thecrag/public-parsing.ts) rejects more than 1,000
reported attempts per ascent before expanding route placeholders or sending
counts to persistence. This is Dofek's local memory/database allocation budget,
not a published theCrag maximum. It applies to routes and boulders, and rejects
the entire batch without truncating counts or changing previously stored logs.

Stable ascent IDs retain the `thecrag:<ascent-id>` identity used by earlier
imports. Route IDs identify shared climbs. The recorded ascent date supplies
the climb day; the feed's publication date is not substituted. Public source
fields remain in `raw.publicFields` with account, ascent, route and tick
provenance. Empty or unavailable public comments do not erase existing notes.
See the [source mapper](../src/providers/thecrag/public-parsing.ts) and
[database integration tests](../src/providers/thecrag-sync.integration.test.ts).

Published route grades belong to the climb; explicit ascent grades belong to
the log. An explicit return to “Inherits from route” clears the previous ascent
grade override; missing grade fields preserve existing information. Clear
V-scale/YDS notation and supported scale prefixes establish a
grade system; ambiguous text retains an unknown system. theCrag documents its
[grade systems](https://www.thecrag.com/en/article/gradesonthecrag) and
[gear styles](https://www.thecrag.com/en/article/styles).
Recorded rope method remains unknown when the source supplies none; sport/trad
protection alone does not prove a lead. Reported counts use the canonical model's
partially described occurrences, with result/qualifier evidence attached only to the
described try. Order, beta and other unreported outcomes remain unknown; see
the [route-method contract](../src/db/climbing-route-method.integration.test.ts).
For combined tick labels such as `Redpoint: Top rope`, the recorded result is
the observed `Redpoint` constituent and the rope method is stored separately.
The full label remains in raw provenance. Database outcome and free-send
projections consume that result without assigning outcomes to anonymous count
occurrences; the [integration tests](../src/providers/thecrag-sync.integration.test.ts)
exercise both serving views.

This is an undocumented public-page integration and can change or become
blocked upstream. theCrag's [terms](https://www.thecrag.com/terms) restrict
programmatic scraping; public visibility is not an API support guarantee.
The official [personal logbook API](https://www.thecrag.com/en/article/logbookreadapi)
remains a separate supporter feature.

## Informational catalogue context

Separately from tick sync, climb details can request disposable catalogue context
across providers. The [catalogue reader](../src/providers/thecrag/catalogue.ts)
uses public route search and route-page tags, retaining direct/inherited scope
and multiple steepness categories. Cached context never writes facts back to
the tick or changes training metrics. See the
[verified source contracts and cache lifecycle](climbing-trait-coverage.md#informational-catalogue-cache)
and theCrag's [tag taxonomy](https://www.thecrag.com/en/article/tagging).

## Transport evidence — 2026-10-26

Fresh logged-out Chrome retrieved a public account's feed, one ascent, its empty
next page and public details. Native Node fetch and curl returned Cloudflare
403 block pages from both the workstation and production; changing only the
User-Agent did not resolve those blocks. The upstream blocking rule was not
identified, so these responses did not establish an authentication requirement.

Impit 0.14.7's default `chrome` profile subsequently retrieved the feed, the
exact next link and ascent details with HTTP 200, no cookies or credentials,
on macOS ARM64 Node 26.7.0 and in a separate container on the production OCI
network using the deployed ARM64 Alpine Node 26.12.1 image. The container ran
as UID 1000 with a 128 MiB memory limit, no application secrets and no browser
process. Production services and deployment configuration were unchanged.
These observations verify that account and network at the time of testing;
they do not establish future availability or historical completeness.
