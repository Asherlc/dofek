# Remove Daily summary and custom scores

Approved scope: remove the Daily summary and retire Dofek's custom recovery
score, 0–21 strain score/targets, sleep-performance score, and their dependent
displays across web and mobile. The user approved removing these everywhere.

Remove the associated API calculations and shared algorithms rather than
leaving hidden implementations. Remove Today Plan and estimated sleep-need
or bedtime recommendations where they depend on these heuristics. Preserve
recorded HRV, heart rate, respiratory rate, sleep, activities, personal-baseline
comparisons, and established workload metrics.

The alternative of hiding only the dashboard section would leave the same
scores elsewhere and retain the algorithms the user asked to retire. Full
removal is the approved approach. No replacement score or new dependency is
part of this change. Existing provider data and historical migrations remain.

Delete tests and stories for deleted features; update surviving tests to
exercise retained behavior. Do not add assertions that deleted features are
absent. Verify types, remaining behavior, and unused references.
