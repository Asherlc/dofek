# Activity identity and source details

The user selected source-disclosure option C and the rounded-outline custom
activity-icon family from the screenshot comparisons. Activity identity leads
every card; a small recording-app logo beside time and duration opens source
details. No source names appear permanently beside that logo.

## Scope and approaches

- Replace the existing 16 emoji-based icon families with one custom rounded
  outline SVG family. Match the approved cycling, running, swimming, strength,
  climbing, and hangboarding samples; extend that geometry to walking, yoga,
  HIIT, elliptical, rowing, winter, water, team, dance, and other.
- Retain the current activity-to-family classification. This change does not
  introduce 90 separate glyphs or change activity classification.
- The user rejected an inline recording-app-to-Apple-Health arrow chain and
  selected a compact source disclosure over an app-only mark, an import badge,
  and source icons in the lower corner.
- Keep recording and import roles separate: Hang Ten appears in the trigger;
  the opened disclosure shows Recorded in / Hang Ten and Imported via /
  Apple Health. A direct WHOOP recording has one row. Unresolved origin does
  not claim a recording app.

## Architecture and constraints

Shared SVG definitions and category mapping stay in `@dofek/training`.
Web and native render the same geometry with theme-appropriate colors through
their existing SVG renderers. SVG geometry follows the
[SVG specification](https://www.w3.org/TR/SVG2/).

A shared presentation helper in `@dofek/providers` derives recording-app and
import-route labels from the existing resolved origin and
`providerSourceLogo`; no storage, API, attribution, or metric behavior changes.
Hang Ten's [published integration](https://apps.apple.com/us/app/hang-ten-training/id6797141761)
saves completed sessions into Apple Health.

Web uses Radix Popover for anchored placement, dismissal, and focus management,
following its [official documentation](https://www.radix-ui.com/primitives/docs/components/popover).
Native uses the existing pressable-plus-modal disclosure pattern, following
[React Native Modal](https://reactnative.dev/docs/modal), with the same roles
and labels. These are platform presentations of the selected tap-for-details
interaction.

Source controls must not navigate, toggle card selection, or become nested
inside another button or link. Preserve the existing card navigation and
selection behavior through separate interaction targets. Keep keyboard and
screen-reader access, close behavior, and focus restoration.

## Acceptance

- All 16 existing activity families have coherent custom outline geometry;
  unknown activities retain a neutral custom activity glyph.
- Web and mobile card, list, and detail activity-icon consumers use the family.
- The activity icon remains visible with both resolved sources and maps.
- Source trigger contains only its recording-app logo and a disclosure cue.
- Source details handle direct WHOOP, Hang Ten/Strong via Apple Health,
  unrecognized Apple Health apps, and unresolved origin truthfully.
- Tests cover classification/rendering and the changed interaction behavior;
  stories and browser screenshots cover actual icon size and source details.
- Update the existing public READMEs to describe the final behavior.

## Review checkpoints

Review each implementation task for these acceptance criteria and code quality,
then review the combined change before committing/pushing the final result.
Run focused unit/mobile tests, typechecks, lint, web build/size checks, and
visual checks appropriate to these UI changes.
