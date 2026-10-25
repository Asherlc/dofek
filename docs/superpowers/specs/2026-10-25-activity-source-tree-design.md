# Activity source tree

Approved in conversation after reviewing the collapsed and expanded card mockup.

## Intent

Explain how an activity propagated through recording apps, devices, and providers,
including branching paths. Keep exactly one card per activity on web and mobile.

## Approved presentation

- Keep the activity identity, time, metrics, and source disclosure inside one border.
- The collapsed source row shows the recording source and a Sources chevron.
- Expanding that row reveals the source tree inside the same card. The row doubles
  as the primary tree root, so the source name is not repeated.
- Use provider logos, thin branch connectors, and concise relationship subtitles.
- Keep Dofek implicit. Preserve separate copies from the same provider.
- Keep the existing activity navigation and selection controls independent of the
  disclosure. Use the [WAI disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/)
  with an expanded state and a controlled content region.

## Approaches

We considered a separate card disclosure, an inline detail-page tree, and a mobile
bottom sheet. The selected approach puts disclosure directly inside the activity
card: it preserves context and prevents a second card for the same activity.

## Data and constraints

- Reuse retained source-member identities and existing evidence edges from
  [the activity origin model](../../../analytics/macros/activity_origin.sql).
  Membership, source priority, and chosen origin do not establish transfer edges.
- Use a provider-agnostic server projection for both clients. No new tables,
  read models, dependencies, or environment variables are needed.
- A source name may identify an upstream app/device even when its own record is
  unavailable. Show that as recording attribution, without asserting an unproven
  transfer between held member records. Strava documents its recording-device
  field in its [activity model](https://developers.strava.com/docs/reference/#api-models-DetailedActivity).
- Keep disconnected components visible as other matching sources. Handle
  ambiguity and cyclic evidence without fabricating a root or dropping copies.
- The existing resolved origin is the closest available record, not proof of
  the first-ever recording. Use wording consistent with that distinction.

## Validation

Test source projection and actual expansion behavior before implementation.
Cover branching, repeated provider copies, incomplete history, source names from
Strava and Apple Health, and independent activity navigation/selection. Verify
the web and mobile stories at phone and desktop widths.

## Activity detail pages

The same visualization also belongs in each activity detail header on web and mobile. Replace the flat source-link row with the existing inline disclosure, retaining the surrounding activity identity, metrics, removal notices, photos, and hardware. The header shows one collapsed source root; expansion shows its branches and other matching sources without a second activity container.

The [detail model](../../../packages/server/src/models/activity.ts) must return the same server-authored tree as the list, including single-source activities. Use retained origin evidence, preserve separate records, and keep empty trees hidden. Removed records remain visible with their removal information, but their unavailable source links are not actionable. Invalidate older detail responses in server and device caches before clients require the new tree. Capture collapsed and expanded production header stories on both platforms with branching sample data.
