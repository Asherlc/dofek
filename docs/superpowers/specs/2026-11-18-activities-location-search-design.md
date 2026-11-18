# Activities location search

Activities on web and iOS will offer location search alongside title search. Submitting a location name shows activities with a matching recorded gym or crag. Users can also look up a public place and select a qualified result such as Oakland, California to find activities with a GPS route centered nearby. Both searches use the existing activity cards, sport filter, and pagination over accessible history.

## Data sources

Use recorded climbing area names from PostgreSQL and existing route centroids from ClickHouse. Use Geoapify for public place lookup only after the user requests it. Send the typed public place query to Geoapify and keep recorded names, coordinates, and activity history inside Dofek. Find nearby routes within 25 km of the chosen place using their centroids. The list stays newest first.

The alternative was to copy names and centroids into the title-search OpenSearch index. That would make unified ranking easier and require a second copy of location data, a historical backfill, and more publication and erasure work. The approved approach uses the existing sources and leaves title ranking on its existing path. [Geoapify Geocoding API](https://apidocs.geoapify.com/docs/geocoding/) · [OpenSearch geographic search](https://docs.opensearch.org/latest/query-dsl/geo-and-xy/geodistance/)

## Acceptance criteria

- Match climbing area names across the recorded path, including locations with no GPS data.
- Identify ambiguous public places with their full labels and require a choice before searching the surrounding area.
- Preserve the sport filter and show only activities the current account owns and can access. Page through matches in descending activity time with a stable tie-breaker and an encrypted, search-scoped continuation token.
- Display lookup and activity query errors independently. Clearing a search returns to the dated activity list.
- Scope the Geoapify credential to the web server. Redact search inputs, activity IDs used for hydration, and the credential from request telemetry. Test the provider contract through an HTTP stub and run activity matching against PostgreSQL and ClickHouse.
