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
Recorded rope method is required for route attempts; sport/trad protection
alone does not prove a lead. Reported counts use the canonical model's
method-only occurrences, with result/qualifier evidence attached only to the
described try. Order, beta and other unreported outcomes remain unknown; see
the [route-method contract](../src/db/climbing-route-method.integration.test.ts).

This is an undocumented public-page integration and can change or become
blocked upstream. theCrag's [terms](https://www.thecrag.com/terms) restrict
programmatic scraping; public visibility is not an API support guarantee.
The official [personal logbook API](https://www.thecrag.com/en/article/logbookreadapi)
remains a separate supporter feature.

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
