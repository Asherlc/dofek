# Compact activity source attribution

Date: 2026-10-25. Visual direction selected: A, icon badges.
Implementation scope proposed for approval.

## Intent

Keep activity source controls compact while preserving the distinction between
the recording device, provider, and delivery path. The device or provider name
leads; a small Apple Health, cloud, or Bluetooth icon supplies attribution.

## Approaches

- **A: icon badges, selected by the user.** Smallest control; full wording is
  available when choosing a source.
- **B: icons with Health, Cloud, or Bluetooth pills.** More explicit at a glance,
  but wider. Shown alongside A in the comparison stories.
- **Existing parenthetical text.** Explicit but unnecessarily long for these
  controls.

## Proposed scope

- Apply A to the activity metric source controls on web and mobile, including
  elevation and heart rate. Reuse the existing provider logos and visual palette
  ([web logos](../../../../packages/web/src/components/ProviderLogo.tsx),
  [mobile logos](../../../../packages/mobile/components/ProviderLogo.tsx)).
- Supply structured names and attribution in the metric-source response rather
  than extracting them from display strings or opaque source IDs
  ([current contract](../../../../packages/server/src/contracts/activity-metric-sources.ts)).
- Keep full textual attribution in the opened chooser and accessible control
  names. Icons complement text alternatives, following
  [WAI non-text content guidance](https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html).
- Preserve distinct sources, source IDs, selection defaults, and metric behavior.
  Badges describe the source path, not connection or sync health.
- Verify source switching and accessibility on both clients, then capture the
  finished controls at desktop and mobile widths.

## Boundaries and implementation decisions

This change concerns activity metric controls; provider settings, activity source
trees, ingestion, and saved priorities stay outside its scope. The implementer
will choose the smallest accessible picker using existing repository primitives.
Web interaction must retain keyboard selection and focus behavior, following the
[WAI listbox guidance](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/).

The comparison stories are design previews. The selected treatment has not yet
been applied to production controls.
