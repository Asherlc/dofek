# Garmin recording-device thumbnails

Use a model-specific product thumbnail in the existing recording-source icon wherever a Garmin activity supplies a recognized device name, on web and iOS. The user selected product thumbnails over line icons. Unknown, absent, ambiguous, or failed images retain the Garmin logo.

## Approach

Reuse the existing `ProviderLogo` source-name input and a shared lookup in `@dofek/providers`. A checked-in, compact snapshot of Garmin's [Connect IQ device catalog](https://apps.garmin.com/api/appsLibraryExternalServices/api/asw/deviceTypes) supplies model names, aliases, and product-image URLs. Prefer verified transparent Garmin product images where available, otherwise use the catalog thumbnail. Clients resolve locally without a runtime catalog request. Images keep their aspect ratio at the existing icon size. Error reporting uses each platform's telemetry boundary.

Product thumbnails distinguish individual models. Custom line icons would require new artwork and make similar watches harder to distinguish. The Garmin logo remains the appropriate image for provider-only contexts.

## Behavior and boundaries

- Match actual models after normalizing accents, trademarks, punctuation, whitespace, and an optional Garmin prefix; do not guess a model from an arbitrary prefix or unknown variant.
- Support documented catalog aliases and grouped-size names, including the existing activity name `fēnix 8 – 47mm`.
- Keep all model selection in the shared package. Preserve current Apple Health attribution and badges.
- Give recording icons an accessible label containing the provider and device name. Keep the activity list concise.
- Do not change ingestion, storage, origin selection, device priorities, or dependencies.
- Cover name matching, unknown models, image failures, and prop changes with tests; provide web/mobile stories and inspect the rendered thumbnails.

## Research

The [Garmin catalog](https://apps.garmin.com/api/appsLibraryExternalServices/api/asw/deviceTypes) supplies `name`, `additionalNames`, and `imageUrl` for current and older devices. These are product-model illustrations; the catalog can group sizes and does not identify a user's color or exact SKU. Recording-device metadata already maps to `activity.source_name` in the [Garmin mapper](../../../src/providers/garmin/activities.ts).
