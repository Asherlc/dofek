# Apple Health Food Write-Back Design

## Goal

Sync nutrition logged directly in Dofek back to Apple Health from the mobile app.

The write-back must include food entries created by Dofek itself, including entries created on web and later seen by mobile. It must not write nutrition that arrived from another provider such as Apple Health import, Cronometer, Slack, or any future external nutrition source.

## Scope

Included:

- Mobile-driven write-back to Apple Health.
- Direct Dofek food entries only, identified server-side by the canonical Dofek provider id.
- Calories, protein, carbohydrates, and fat, matching the HealthKit write permissions that already exist in the native module.
- Idempotent mobile sync so repeated syncs do not duplicate HealthKit samples.
- Manual trigger from the Apple Health provider card and automatic reconciliation during mobile sync.

Excluded:

- Writing provider-synced nutrition back to Apple Health.
- Writing micronutrients, water, supplements, meal names, or serving details in the first version.
- Web-side Apple Health write-back. HealthKit writes can only happen from iOS.
- Cross-device write-back state sharing unless a later implementation needs it.

## Current State

The iOS HealthKit module already requests write permission for:

- `HKQuantityTypeIdentifierDietaryEnergyConsumed`
- `HKQuantityTypeIdentifierDietaryProtein`
- `HKQuantityTypeIdentifierDietaryCarbohydrates`
- `HKQuantityTypeIdentifierDietaryFatTotal`

Only `writeDietaryEnergy()` is currently exposed to TypeScript. It is not wired into the food logging flow. The app already syncs HealthKit data into the server; this design adds the reverse nutrition path for Dofek-owned entries.

## Architecture

### Server Export Endpoint

Add a protected server endpoint for mobile to fetch writable Dofek nutrition entries.

The endpoint returns confirmed food entries for the current user where `provider_id = 'dofek'`, constrained by a date range. It returns only fields needed for HealthKit write-back:

- food entry id
- date
- food name
- calories
- protein grams
- carbohydrate grams
- fat grams

The server owns the provider filter. Mobile must not infer direct-vs-provider-synced status from labels or client-side heuristics.

### Mobile Reconciliation

Add a mobile write-back sync module that:

1. Fetches direct Dofek food entries for a bounded date range.
2. Builds one HealthKit quantity sample per present writable nutrient.
3. Writes samples through the native HealthKit module.
4. Records local write-back state keyed by food entry id and content fingerprint.
5. Skips entries whose fingerprint has already been written successfully.

The sync should run after successful mobile refresh/HealthKit sync and be available as a manual action from the Apple Health provider card.

### Native HealthKit API

Replace the single-purpose `writeDietaryEnergy()` bridge with a general `writeDietarySamples()` writer. The TypeScript API should support the four writable dietary quantity identifiers and reject unsupported types.

Each written sample should include metadata identifying:

- Dofek as the writer
- the Dofek food entry id
- the nutrient type
- the content fingerprint

If HealthKit supports reliable delete-by-metadata in the existing bridge, changed entries should delete old Dofek-written samples before writing replacements. If deletion is not reliable enough, implementation must stop for user approval rather than shipping duplicate-prone update behavior.

## Idempotency

Use local persisted state in mobile, keyed by food entry id.

For each entry, compute a fingerprint from the fields that affect HealthKit output:

- date
- calories
- protein grams
- carbohydrate grams
- fat grams

If the stored fingerprint matches the current fingerprint, skip the entry. If it differs, treat the entry as changed and rewrite it only if old samples can be deleted cleanly.

Local state is acceptable for the first version because HealthKit writes happen on-device and the immediate requirement is mobile reconciliation. A future server-backed write ledger can be considered only if multi-device idempotency becomes a real requirement.

## Data Flow

1. User logs food directly in Dofek on web or mobile.
2. The server stores the food entry with provider id `dofek`.
3. Mobile write-back sync fetches Dofek-owned food entries.
4. Mobile skips entries already written with the same fingerprint.
5. Mobile writes HealthKit dietary calories/macros for remaining entries.
6. Mobile records successful write-back fingerprints locally.

## Error Handling

HealthKit write failures must be surfaced in the mobile UI and reported to Sentry with enough context to identify the failing entry and nutrient type. Missing HealthKit availability or authorization should produce an actionable message rather than silently skipping write-back.

The server endpoint should fail normally through tRPC errors if the user is unauthenticated or the query fails.

## Testing

Server tests:

- Endpoint returns only confirmed `dofek` provider food entries.
- Endpoint excludes Apple Health, Cronometer, Slack, and other provider-owned nutrition.
- Endpoint returns only the writable HealthKit nutrition fields.

Mobile tests:

- Write-back skips already-written fingerprints.
- Write-back writes calories/protein/carbs/fat when present.
- Write-back does not write absent nutrients.
- Write-back reports HealthKit write failures to Sentry.
- Changed entries are rewritten only when old sample deletion is supported.

Native tests:

- Write type registry still contains the four supported dietary types.
- General dietary writer rejects unsupported HealthKit quantity identifiers.

## Open Implementation Check

Before implementation, verify HealthKit deletion support for Dofek-written samples by metadata. If reliable deletion cannot be implemented, ask for approval before choosing a more limited first version.
