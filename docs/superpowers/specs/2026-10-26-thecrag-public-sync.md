# theCrag public tick sync

Connect a public theCrag username or profile URL and automatically import its
public ascents without a personal API key, account login, or browser process.
Keep the existing daily provider schedule and the same connection form on web
and mobile.

## Read contract

Resolve the username through the public climber lookup, follow the account's
Atom ascent feed, and fetch each discovered ascent's public detail page. The
feed route is documented in the [maintainer discussion](https://github.com/theCrag/website/issues/1997).
Use stable ascent and route identifiers, the recorded climb date, recorded rope
method, published/reported grades, public notes, and reported attempt count.
Do not substitute the event publication date for the climb date. Represent a
reported count through the canonical model's method-only placeholders when the
ascent explicitly supplies that method; only the described try receives tick
result or qualifier facts. Unknown order, outcomes and beta stay unknown.
Preserve source fields as provenance.

Feed entries are events and historical discussions describe grouped summaries
([discussion](https://github.com/theCrag/website/issues/1837#issuecomment-71587804)).
Therefore, persist observed entries additively; missing feed entries never
prove deletion. This does not promise a complete historical backfill or private
notes. Stop on malformed content, pagination loops, mismatched owners/IDs,
non-public redirects, and failed detail requests before writing any records.

## Transport

Use provider-local `impit@0.14.7` with the tested `chrome` HTTP profile, normal
TLS verification, no proxy or cookie jar, and the existing shared provider
rate-limit/diagnostic/deadline boundary. Impit is an HTTP client with native
[ARM64 musl support](https://apify.github.io/impit/js/), not a running browser.
Parse HTML with `cheerio@1.2.0` and validate XML with the existing SAX parser;
[Cheerio](https://cheerio.js.org/docs/intro/) does not execute scripts.
Temporary probes on macOS and in a separate constrained production ARM64
container returned 200 for the feed, its next page, and ascent details.

## Existing connections and data

New public identities use scope marker `thecrag:public-profile` and store the
resolved numeric account ID explicitly. Old personal-key or unmarked saved
connections require reconnection before network requests; never interpret an
old secret as a username or put it in a URL. Preserve existing log entries and
attachments. Account erasure must continue to block on old remote credentials
until the owner revokes their key and disconnects/reconnects; a public-profile
classification alone is not proof of revocation. Personal keys are managed in
the owner's [API settings](https://www.thecrag.com/en/article/logbookreadapi).

## Validation

Test parsing and connection behavior first, then public-feed pagination and
failure atomicity. Real PostgreSQL integration tests must prove repeated syncs
update stable records, preserve attachments and unobserved records, and keep
users isolated. Verify both clients' public-profile form, targeted typechecks,
lint and spelling, plus a live read using the implemented production client.
