# Climb list to HR chart highlight

Approved direction: hovering or keyboard focusing a climb in the web activity list highlights its existing HR chart line or time range. Leaving the row clears the highlight unless keyboard focus remains. Mobile climb selection provides the equivalent persistent highlight.

Reuse the annotation ID supplied by the [server projection](../../../packages/server/src/services/climbing-chart-annotations.ts) and existing list/map interactions. Untimed and out-of-range climbs retain their current behavior without inventing positions. Keep details and map selection intact.

## Approaches

The selected approach passes an active entry ID from the list through the activity page into the chart, emphasizing the existing annotation. Programmatically moving the chart tooltip would tie the interaction to sample availability and cannot represent an entire climb range as directly. No new library or metric computation is needed.
