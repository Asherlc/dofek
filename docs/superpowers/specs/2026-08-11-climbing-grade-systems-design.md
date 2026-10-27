# Climbing grade-system preference

## Goal

Let a user choose the climbing-grade system used for bouldering and routes,
just as they choose metric or imperial display units. The choice applies to
manual logging and to every climbing display on web and mobile.

## Scope

The preference is separate by climbing discipline:

| Discipline | Available display and input systems |
| --- | --- |
| Boulder | V Scale, Fontainebleau |
| Route | Yosemite Decimal System, French, UIAA, Ewbank, Saxon, Norwegian, Brazilian Crux |

Aid and ice systems are out of scope because Dofek currently models only
`boulder` and `route` climb types.

## Architecture

Use `@openbeta/sandbag` version `0.0.55` as the single source for grade
validation, conversion, grade lists, and score ordering. It is MIT licensed,
supports the systems above, and only allows conversions within a discipline.
Sandbag's package documentation describes the supported systems and its
cross-scale conversion behavior: <https://github.com/OpenBeta/sandbag>.

The server owns grade conversion. Raw climbs retain the grade and grade system
that were supplied at logging or ingest time; no normalized score or converted
grade is stored. Server responses add the selected display grade required by
the clients and retain the original value/system for provenance. This follows
the repository rule that clients render server-computed values and avoids a
second source of conversion logic.

Expand the accepted source grade-system values from the current V Scale/YDS
pair to the in-scope systems. Replace existing custom grade parsing and sorting
with Sandbag-backed validation and score ordering so there is one canonical
implementation.

## Preferences and data flow

Store two independently persisted account preferences through the existing
settings mechanism:

- boulder display grade system;
- route display grade system.

The settings screen on web and mobile exposes two accessible selectors. Each
selector includes only systems compatible with its discipline and updates
optimistically, rolling back and displaying the server error if saving fails.

The manual climbing logger reads the current preference for the selected climb
type, presents that system's valid grades, and saves the chosen grade with that
system as its raw source. The server validates it through Sandbag before
writing.

All climbing APIs that serve activity detail, progressions, volume, session
summaries, and mobile training data resolve the requesting user's display
preference and return converted display grades. Existing records remain in
their original system. If a historical value cannot be converted, retain and
display its recorded value/system instead of dropping or silently changing it.

## Error behavior

Invalid or incompatible grades submitted from a manual log fail with a
specific actionable message naming the grade and selected system. Conversions
never cross disciplines. Failed preference reads/writes use the existing
telemetry and user-visible error patterns on both clients.

## Verification

Write tests first, then implement. Coverage includes:

- Sandbag-backed validation, conversion, and ordering for every in-scope
  system;
- rejected invalid grades and cross-discipline conversions;
- persisted independent route and boulder preferences;
- server responses for all climbing views using the chosen display system while
  preserving source provenance;
- web and mobile settings selectors, logger grade choices, and converted
  displayed grades.

Run focused unit tests while developing, followed by the affected workspace
test suites, lint, and typecheck before handoff.
