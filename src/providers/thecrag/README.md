# theCrag

The [provider](provider.ts) owns authentication, API pagination, source mapping,
and synchronization for the personal logbook API. See the [provider guide](../../../docs/thecrag.md)
and [official API documentation](https://www.thecrag.com/en/article/logbookreadapi).

[Persistence](persistence.ts) calls the shared climbing writer, preserves its
actionable missing-method errors, and sanitizes unexpected database failures
before reporting them. Unit tests live beside their source modules; the
[integration suite](../thecrag-sync.integration.test.ts) exercises stored records.
