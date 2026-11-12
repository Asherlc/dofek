# theCrag

The [provider](provider.ts) imports the key owner's logbook through the official
[personal Logbook Read API](https://www.thecrag.com/en/article/logbookreadapi).
It uses native fetch through the shared provider HTTP boundary. Both clients
collect a concealed personal key and disclose active supporter status and
private-note access; old public-profile connections must reconnect.

The [client](client.ts) validates paginated responses, and the [mapper](mapping.ts)
produces canonical climbing logs with stable ascent IDs. The
[progress store](progress.ts) scopes source-epoch cursors to user, remote account
and connection identity. All pages validate before [persistence](persistence.ts),
and progress advances only after successful writes. Imports remain additive;
no missing-record tombstones or synthetic workouts are produced. See the
[provider guide](../../../docs/thecrag.md) and
[Postgres integration suite](../thecrag-sync.integration.test.ts).

The official personal API supports this owner's logbook; it does not document
general cross-provider catalogue discovery. Dofek no longer reads theCrag public
pages for catalogue enrichment. The site policy prohibits screen scraping for
programmatic access, and the general integration guide says API access requires
a legal agreement. See the [usage policy](https://www.thecrag.com/en/terms),
[API integration guide](https://www.thecrag.com/en/article/extend), and
[personal logbook API](https://www.thecrag.com/en/article/logbookreadapi).
