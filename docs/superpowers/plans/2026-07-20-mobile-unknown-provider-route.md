# Mobile unknown-provider route implementation plan

## Problem

The iOS provider detail route accepts arbitrary provider IDs. Opening `dofek://providers/does-not-exist` renders a normal-looking provider page titled “Does Not Exist,” with empty readiness, sync-history, and records sections. The app has no such provider, so this fabricated detail screen can mislead users and conceals malformed or stale links.

## Evidence

- Reproduced in a signed Release build on an iPhone 17 Pro simulator with the deep link `dofek://providers/does-not-exist`.
- `packages/mobile/app/providers/use-provider-detail-actions.ts` returns `undefined` when the requested ID is absent from `sync.providers`.
- `packages/mobile/app/providers/[id].tsx` only treats loading or an empty route parameter specially. Once loading completes, it renders even when `displayProvider` is absent and generates a title with `formatProviderName(providerId)`.

## Implementation

1. Add a failing route test for a non-empty provider ID that is absent from the provider inventory. Mock provider-detail, records, logs, disconnect, and sync APIs separately and assert each has zero calls after inventory validation.
2. After the providers query succeeds, render a specific “Provider not found” state when neither a server provider nor the supported local Apple Health provider matches the ID.
3. Provide an accessible action back to the provider list; do not issue detail records, logs, disconnect, or sync requests for the unknown provider.
4. Preserve the existing loading, valid server-provider, and Apple Health paths.

## Acceptance criteria

- Unknown provider IDs never render a fabricated provider name or normal provider data sections.
- The error state explains that the provider is unavailable and lets the user return to Data Sources.
- No provider-detail API requests are made for an unknown ID after inventory validation.
- Valid provider routes and Apple Health continue to work.

## Validation

- Run the focused provider-detail route tests.
- Open valid and invalid `dofek://providers/<id>` links in a signed Release simulator build.
