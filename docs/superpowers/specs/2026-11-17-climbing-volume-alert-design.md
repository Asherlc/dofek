# Climbing volume increase alert

## Purpose

Give climbers a heads-up when recent recorded climbing time rises substantially above their own recent training. The approved starting threshold is an increase of at least 25% and at least 60 minutes.

Retrospective indoor climbing research associated higher weekly hours and harder grades with prolonged injuries. A prospective recreational climbing cohort found no significant association with climbing time. A prospective bouldering study measured weekly hours only at enrollment, which left changes over time unmeasured. The proposed threshold is a product heuristic to calibrate against historical activity logs. [Retrospective study](https://journals.sagepub.com/doi/full/10.1016/j.wem.2023.05.002) · [Recreational climbing cohort](https://pubmed.ncbi.nlm.nih.gov/25958937/) · [Bouldering cohort](https://journals.sagepub.com/doi/10.1016/j.wem.2021.02.002)

## Proposed delivery

Show a single informational callout beside the Climbing Volume chart on [web](../../../packages/web/src/routes/training/climbing.tsx) and [iOS](<../../../packages/mobile/app/(tabs)/strain.tsx>). Compute it when the training surface loads or refreshes. The callout clears when the condition stops holding and updates when late imports or edits change the totals. Its windows are relative to today in the account timezone and apply to all recorded climbing across the account. The selected chart range and filters control the chart.

> **Climbing volume increased**
>
> You logged 5 hours of climbing in the last 7 days, up 43% from your recent weekly average of 3 hours 30 minutes.

A current training callout gives the numbers beside the user's climbing history and can be derived from the current data. The existing [Alerts page](../../../packages/web/src/pages/AlertsPage.tsx) presents provider and processing issues. Proactive push would reach people away from Training and would require a trigger, event lifecycle and delivery policy. The proposed first release is the in-app callout.

## Volume and trigger

- Use the authenticated user's canonical climbing activity groups. Count a group once using its recorded workout bounds. A log-only group represents a first-to-last log span, so it contributes no workout minutes and does not by itself qualify a baseline week. A mixed group with recorded workout bounds contributes its workout duration once. The [canonical group view](../../../drizzle/_views/01_v_activity.sql) defines both forms. Dedicated hangboard workouts and hiking have their own activity types.
- Assign each completed workout to its start date in the account timezone, consistent with the [existing volume chart's date attribution](../../../packages/server/src/repositories/climbing-repository.ts). Use actual elapsed time between the recorded bounds, including any rest inside the session. A workout that ends after the evaluation time contributes once it completes. A missing or nonpositive duration on an otherwise eligible workout makes the current comparison unavailable, because the total could skew either window.
- Sum climbing time for today and the previous six local dates. The baseline is the sum over the immediately preceding 28 local dates divided by four. For a local date `D`, these are inclusive ranges `D−6` through `D` and `D−34` through `D−7`. Today's completed sessions count as soon as the latest data is available. Daylight saving changes the dates' elapsed length, and workout duration still uses elapsed time.
- Require access to all 35 dates and at least one measured workout in two distinct seven-day baseline blocks. All four blocks remain in the denominator, so genuinely quiet weeks contribute zero. These eligibility rules are proposed defaults that reduce alerts from sparse history and prevent restricted history from being treated as zero. Use the existing [billing access window](../../../packages/server/src/billing/entitlement.ts).
- Trigger when recent volume is at least `baseline × 1.25` and at least `baseline + 60 minutes`. Compare unrounded elapsed durations and round only for display. For a 4-hour baseline, 5 hours is an exact hit on both conditions. For a 1-hour baseline, 1 hour 30 minutes falls short of the absolute threshold. For an 8-hour baseline, 9 hours falls short of the relative threshold.

## Server and client contract

Add a protected, fixed-window climbing query. Read bounded rows from the canonical activity-group projection and use its active-member provenance to identify groups with a recorded workout. Reuse the existing ownership, visibility, and access rules. The current volume chart uses calendar-week buckets and can include log-only bounds, so the alert uses a separate calculation over the same underlying activity groups. A duration-only read can use Postgres without sensor hydration. Derive the result on demand.

Return a typed result for an active increase, a comparison below the thresholds, or insufficient comparable data. Return the recent total, baseline weekly average and computed percent increase for the active case. Both clients use existing duration formatting and render the same numbers and copy. Normal loading and unavailable data leave the callout absent. Query failures use the platform's existing error handling while the volume chart remains usable. Use the normal query refresh behavior and include the alert in mobile's training refresh.

## Acceptance and calibration

1. Write failing calculation tests first for both thresholds at equality and independently below, quiet weeks, a sparse baseline, and the 7/28-day boundary. Check an overlapping midnight or daylight-saving case against the specified local-date attribution.
2. Verify with PostgreSQL fixtures that overlapping provider records in a canonical group count once, log-only spans contribute no minutes, mixed groups use recorded duration, and incomplete bounds and restricted access suppress the comparison. Cover user isolation and excluded activity types.
3. Verify web and iOS show the one callout with the same numbers, keep it independent of chart filters, and update or clear it on refresh. Review the accessible name and reading order on each platform.
4. Before rollout, replay the candidate rule on available historical training logs with appropriate access. Count episodes as consecutive eligible dates where the rule fires, and inspect examples caused by an extra session, a quiet baseline, or a change in tracking coverage. Use the frequency and examples to decide whether the starting threshold needs adjustment. A replay evaluates alert frequency and usefulness as a record of volume change.
