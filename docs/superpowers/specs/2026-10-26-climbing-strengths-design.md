# Climbing strengths and weaknesses

The user approved the heatmap and compact mobile profile mockups in this conversation. The climbing training screens should explain recorded success by grade and route characteristics, with selectable cells/rows that reveal the actual climbs behind each result.

## Intended behavior

- Web uses a grade-by-style heatmap; mobile uses a grade selector and horizontal style profile. Both expose wall angle, hold type, and indoor/outdoor breakdowns.
- Each identified climb counts once per context in the selected period. A recorded free send establishes success; a recorded failure without a send establishes failure. Unknown outcomes do not establish failures. Conflicting recognized grades exclude the climb from grade-based analysis and appear in excluded-grade record coverage. Existing [rock observations](../../../packages/server/src/repositories/climbing-rock-observations.ts) remain the outcome authority.
- Missing source grade systems may adopt the sole recognized system from the same established climb identity and semantic lane; multiple recognized systems remain separate and cannot supply a guessed context. Explicit date anchors define inclusive calendar-day windows. See the [context resolution](../../../packages/server/src/services/climbing-strengths.ts) and [date projection](../../../packages/server/src/repositories/climbing-strengths-repository.ts).
- Keep bouldering, routes, attempt scope, rope method, solo/aid facts, and grade systems separate. Indoor/outdoor comparisons explicitly identify both settings; wall/hold comparisons stay within a recorded setting.
- Cells show sends, distinct climbs, percentage, and a server-computed comparison with the same-grade baseline. Fewer than five climbs is labeled limited data; zero success, no data, and missing metadata remain distinct.
- Selecting a result reveals up to three real climbs, recorded date/outcome, source, and available activity/source links. Show concise source facts once.
- Show missing trait, unknown outcome, unrecognized grade, and unidentified climb coverage. Preserve cached content while refetching; surface server errors.

## Data scope

Use canonical recorded setting, hold type, and wall angles whose units and convention are established. Kaya angle units and sign are [unverified](../../kaya.md); these values remain unknown. The [theCrag API](https://www.thecrag.com/en/article/logbookreadapi) describes route steepness tags, but the retained JSON shape has not been verified, so this implementation must not invent tag keys or consume ascent equipment tags. No new external service, dependency, schema storage, or description-based guessing is required.

The existing data model is a useful starting point, but provider coverage limits wall/hold analysis. Indoor/outdoor supplies a useful current breakdown; empty wall/hold panels explain precisely what is missing. Known degree angles retain exact numeric labels because the source's zero/sign convention has not established categorical slab/overhang labels. This limitation is part of the initial implementation, not a claim that every provider supplies route traits. See the [server classification](../../../packages/server/src/services/climbing-strengths.ts).

## Approaches considered

1. Grade-by-style heatmap: exposes patterns across grades; selected counts and examples make sparse cells assessable. Chosen for web.
2. One-grade style profile: makes comparisons readable at phone widths. Chosen for mobile.
3. A composite ability score or radar chart: would hide denominators and require additional modeling; excluded from this feature.

## Implementation constraints

All numerical analysis and classifications are computed on the server. Shared Zod contracts and presentation labels live in `@dofek/training`. Use existing repositories, query caching, UI controls, and chart conventions. Interactive controls follow the [WAI disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/) for expandable coverage details. Tests cover actual aggregation and executable database behavior, plus interactions on both clients.
