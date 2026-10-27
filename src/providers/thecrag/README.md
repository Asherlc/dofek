# theCrag

The [provider](provider.ts) connects a public username, follows the account's
Atom feed and imports public ascent details. It uses a provider-local
[HTTP client](public-transport.ts) without a browser process, login or API key.
See the [provider guide](../../../docs/thecrag.md),
[feed history](https://github.com/theCrag/website/issues/1997), and
[Impit documentation](https://apify.github.io/impit/js/).

[Persistence](persistence.ts) calls the [additive log writer](../../db/climbing-log-sync.ts),
preserving unobserved records because feed events are not a complete snapshot.
It preserves actionable missing-method errors and sanitizes unexpected database
failures. Unit tests live beside source modules; the
[integration suite](../thecrag-sync.integration.test.ts) exercises stored records.

The separate [catalogue reader](catalogue.ts) supports disposable informational
lookups, including multiple/inherited steepness tags. It does not write to the
climbing graph; see the [cache lifecycle](../../../docs/climbing-trait-coverage.md#informational-catalogue-cache).
