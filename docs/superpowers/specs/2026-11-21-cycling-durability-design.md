# Cycling durability design

The approved [Canvas preview](../../../design/cycling-durability/comparison.html) compares a rider’s best cycling power at any point in the selected rides with their best power for the same duration after a specified amount of pedaling in that ride. Dofek shows the result in the existing web and iOS Training → Cycling screens. It uses imported data and needs no data-entry flow.

## Comparison

Van Erp et al. analyzed outdoor training and racing power-meter files. They compared 10-second, 1-minute, 5-minute, and 20-minute best mean power after at least 0, 10, 20, 30, 40, and 50 kJ/kg of accumulated mechanical work. The 0 kJ/kg reference admits efforts from any point in an eligible ride. The same observed effort can win at more than one threshold. Rankings use mean power per kilogram, and the study reports the percentage decrease from the 0 kJ/kg value. [Published field method](https://doi.org/10.1249/MSS.0000000000002656)

Both results use the same rider, date range, riding setting, and effort duration. Work is the time integral of observed watts from the start of the source recording to the start of the effort. The mean power uses elapsed time over the effort. An effort qualifies at exact equality with the requested work. Calculate comparisons before rounding. Retain recorded zeros and withhold results when coverage of the work or effort is incomplete. Report what the rider recorded in the selected rides and retain the observed activity and source evidence.

The controlled studies use different preparation and measured maximal trials. Their thresholds and classifications do not apply to the selected observational method. Prior intensity can affect the comparison even at similar total work. The panel describes what happened at the selected work level and avoids attributing the change to a cause. [Indoor controlled trial](https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2025.1530162/full) · [Outdoor controlled trial](https://doi.org/10.1002/ejsc.12077)

## First-release eligibility

- Use known outdoor cycling activities, completed and accessible within the selected chart range. Withhold rides with unknown setting. Indoor and virtual rides require a separately approved application of the field method.
- Require recorded meter power from one source member for the work and effort. Honor explicit sample provenance or positive meter evidence for that exact member, such as the Strava activity’s `device_watts` flag. Estimated power, ambiguous fields, and a different member’s evidence cannot qualify a stream. The meter model remains unknown when the import does not identify it. [Strava API](https://developers.strava.com/docs/reference/)
- Use Dofek’s existing [body-weight matching policy](../../../packages/server/src/repositories/nearby-weight.ts) on the ride’s local date. Select a same-day observation first, then interpolation between observations no more than 14 days on each side, then the nearest observation within 30 days. The study monitored body mass through its seasons. Treat interpolation and nearest-observation matching as Dofek’s approved adaptation and show the matching method and source dates with each effort. Exclude a ride when the existing policy cannot supply a weight. [Published field method](https://doi.org/10.1249/MSS.0000000000002656)

## Presentation

Keep the approved title **Power after sustained riding** and the default 5-minute, 30 kJ/kg selection. Lead with the difference and the two effort values. Put the date range beside the title and explain that kilojoules measure work at the pedals.

Select the best efforts by W/kg. When the winning rides use the same matched weight, present the result in watts as shown in Canvas. When weights differ, present the primary result in W/kg and put raw watts in the ride details so the headline follows the ranking. A work cutoff can be shown in total kJ when it uses the same matched weight across the selected rides. When it varies by ride, show the cutoff as kJ per kilogram of body weight and display the actual kJ before each effort in the details.

**Change comparison** offers the four durations and five nonzero work levels. **See the rides behind these numbers** names the rides, effort offsets, actual work, weight evidence, and recorded power provenance. Include the riding setting there. Distinguish lack of qualifying inputs from an eligible baseline with no effort after the selected work. Disclose if both values come from the same effort. The result is a comparison of recorded efforts and supplies no performance grade.

## Verification

Prove that prefix work excludes the winning effort, recorded zero watts are valid, and a break in coverage prevents later windows from being compared. Include a ride whose overall best occurs before the selected work so the result must use a later effort. Check signed-in user, time zone, access window, outdoor setting, duplicate imports, source and body-weight proof, and the different-weight display. Verify both clients use the same server result and exercise the empty and available states.
