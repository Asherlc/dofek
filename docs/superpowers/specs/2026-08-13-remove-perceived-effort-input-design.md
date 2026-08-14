# Remove Perceived-Effort Input Design

## Scope

Remove the activity-level perceived-effort input UI from both web and mobile activity-detail screens. This is a presentation-only removal: it does not change stored RPE values, server contracts, or non-input RPE displays elsewhere in the product.

## Client changes

- Delete the web and mobile `ActivityPerceivedExertion` components.
- Remove each component's import and render call from its activity-detail screen.
- Delete the now-orphaned component tests and Storybook stories.

## Preserved behavior

- `fitness.activity.perceived_exertion` remains the canonical nullable session RPE field documented in the existing subjective-input design.
- The activity API continues to expose and accept session RPE so existing data and supported consumers are unaffected.
- Strength-set RPE displays and manual strength/climbing logging controls remain unchanged because they are separate from the activity-level input UI.

## Testing

No new negative-assertion tests are added for the deleted UI. Existing page tests and client type checks will verify that the activity-detail screens continue to render without the removed component.
