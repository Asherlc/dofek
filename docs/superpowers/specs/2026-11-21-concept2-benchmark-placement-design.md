# Concept2 2,000 m RowErg benchmark placement

## Scope

Show how an imported Concept2 2,000 m RowErg time compares with the published cutoffs for submitted Concept2 participants in the same ranking season. Use the non-adaptive division as the default reference group, with all ages, genders, weight classes, countries, and verification statuses in that division. The athlete's own adaptive classification stays unknown. The user approved using the published times and the default reference group. [Concept2 benchmark guidance](https://www.concept2.com/blog/is-my-time-or-distance-good) · [2026 rankings](https://log.concept2.com/rankings/2026/rower/2000?rower=rower)

## Eligibility

- Use an active Concept2 source result in the user's activity group. Read the machine, distance, time, workout format, and ranking status from the same result. Withhold placement if multiple eligible source results disagree or the activity belongs to another user or falls outside the user's access window.
- Require the provider's `rower` machine type, exactly 2,000 m, the documented fixed-distance format, a valid positive elapsed time at the provider's tenths-of-a-second precision, and `ranked: true`. The ranking flag confirms that the result was submitted to Concept2's rankings. It supplies evidence of eligibility under Concept2's rules, which call for a preset single-distance piece from a stationary flywheel. A fixed-distance record alone leaves the start conditions unknown. [Logbook API](https://log.concept2.com/developers/documentation/) · [Ranking rules](https://log.concept2.com/rankings) · [Logbook help](https://log.concept2.com/help)
- Use the source's local completion date. The 2026 ranking season runs from May 1, 2025 through April 30, 2026. The date May 1, 2026 starts the 2027 season. Withhold placement when the source date, ranking status, or matching season cutoff is missing. [Concept2 season rules](https://log.concept2.com/help)

## Proposed implementation

1. Preserve the source's completion date and ranking status in the Concept2 activity's existing provider data through both polling and webhooks. Existing records can gain these fields through normal Concept2 resync. Use the elapsed time from the same source result. A broader correction to stored activity timestamps belongs in separate work.
2. Keep a small server-side reference table of the four published cutoff times and their source URL and capture date. Start with the completed 2026 season and a dated snapshot of the active 2027 season. The active ranking changes as participants submit times. A live integration would require polling public HTML because the documented API has no rankings endpoint. A dated snapshot supports both seasons without a request-time dependency. [2026 rankings](https://log.concept2.com/rankings/2026/rower/2000?rower=rower) · [2027 rankings](https://log.concept2.com/rankings/2027/rower/2000?rower=rower) · [Concept2 ranking rollover](https://www.concept2.com/blog/using-the-online-ranking-as-a-training-tool)
3. Compare elapsed time with the official 90th, 75th, 50th, and 25th percentile cutoffs on the server. Return the highest cutoff met, or that the time was slower than the 25th-percentile cutoff. An exact tie meets the cutoff. For example, a 2026 time of 7:10.0 meets the published 75th-percentile cutoff of 7:19.3. Report the cutoff comparison at the published precision.
4. Use the existing activity detail on web and iOS to show the comparison, ranking season, reference group, and Concept2 source. Show the capture date for the active season. This comparison needs no new screen, settings, or user input.

## Acceptance checks

- Observe failing tests before implementing the import and comparison. Verify polling and webhook persistence, exact ties, a tenth of a second on either side of a cutoff, and both sides of the April 30 and May 1 season boundary using the source date.
- Verify placement is absent for unknown or unranked status, missing dates or cutoff data, conflicting results, intervals, free rows, other distances, other machines, and records without an active Concept2 source. Exercise activity-group membership and access rules with a real database.
- Verify the existing detail views show the same server-computed comparison and label on web and iOS. Verify the published values and source attribution against the selected season pages. Run repository lint, all package typechecks, and the relevant unit, mobile, and integration tests before pushing application changes.
