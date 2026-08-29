# Clinical Record Vault Design

## Goal

Make Dofek's declared Clinical Health Records capability real and reviewer-verifiable: users explicitly authorize an Apple Health clinical-record sync, Dofek stores and displays the resulting FHIR records on web and iOS, and App Review can inspect a permanent account containing clearly synthetic clinical data.

## Scope

This design covers every clinical record category exposed by the supported HealthKit deployment target: allergy, condition, coverage, immunization, lab result, medication, procedure, vital sign, and clinical note when the OS supports it. HealthKit clinical records contain FHIR resources and are queried as `HKClinicalRecord` samples; their sample timestamps reflect download time, not necessarily the clinical event time. [Apple: HKClinicalRecord](https://developer.apple.com/documentation/healthkit/hkclinicalrecord)

The feature is read-only. Dofek does not diagnose, prescribe, alter records, or write clinical data to HealthKit. It does not register clinical records for background delivery; a user starts each clinical-record sync from the Apple Health provider screen.

## Canonical Data Model

`fitness.clinical_record` becomes the one canonical persisted representation of a FHIR clinical record. It contains the account and provider identifiers, HealthKit UUID, HealthKit clinical type, display name, source institution, FHIR version, complete FHIR JSON, HealthKit download timestamp, and the recorded/issued timestamps when they can be faithfully extracted from FHIR.

The uniqueness key is `(user_id, provider_id, external_id)`. The raw FHIR JSON is retained exactly as supplied by HealthKit; the API derives a bounded display summary at read time. No wide clinical tables, shadow copies, or client-side FHIR parsing are introduced.

A forward-only migration will backfill the existing `lab_panel`, `lab_result`, `medication`, `condition`, and `allergy_intolerance` rows into `clinical_record`, update every writer and reader, then remove those former canonical tables and obsolete views/counts. The migration preserves source attribution and keeps medication-dose events separate: a dose event is an adherence event, not a FHIR clinical record.

## Native and Server Contract

The iOS HealthKit module requests authorization for the same clinical types it can query. Its new `queryClinicalRecords(typeIdentifier, startDate, endDate)` bridge uses `HKSampleQuery`, maps `HKClinicalRecord` metadata and FHIR payload to a typed transport record, and reports authorization and query errors through the existing actionable error path. Apple documents `HKSampleQuery` as the clinical-record query mechanism. [Apple: Accessing a User's Clinical Records](https://developer.apple.com/documentation/healthkit/accessing-a-user-s-clinical-records)

`syncHealthKitToServer` queries each authorized clinical type only during an explicit user-initiated sync, batches records to a dedicated authenticated tRPC mutation, and fails the affected sync visibly if the server rejects a record. The server validates the transport envelope and FHIR JSON shape, upserts the canonical raw record, and scopes every read/write to the authenticated user.

The API exposes a paginated clinical-record list and a detail query. It produces all display fields and type/source/date labels on the server; mobile and web only render them. A detail response includes the stored FHIR JSON in a read-only, structured viewer and never modifies it.

## User Experience and Controls

The Apple Health provider detail screen states that clinical records are optional, read-only, and synced only when the user connects or taps Sync. It links to the Clinical Records list when records exist. The existing provider data deletion removes all clinical records belonging to Apple Health; account deletion removes all account-held clinical data. Removing HealthKit permission in iOS Settings prevents future access, while Dofek's provider-data deletion removes already-uploaded data.

Web and mobile provide equivalent Clinical Records list and record-detail surfaces, grouped by record type and source. Empty, permission, loading, and server-error states remain distinct. The UI labels App Review seed data as "Demo data — synthetic" and does not expose a demo-mode toggle to ordinary accounts.

## Reviewer Account and Screenshots

The permanent App Review account is populated only with deterministic, synthetic FHIR fixtures spanning every supported type. It must have working, non-expiring credentials and a live backend. The App Review notes will give the credentials, route to Apple Health, Clinical Records, and provider-data deletion, and state that all listed clinical records are synthetic. Apple requires a working demo account or fully featured demo mode for account-based functionality. [Apple: App Review Guidelines 2.1](https://developer.apple.com/app-store/review/guidelines/)

Native captures are generated after logging into this account on the final release candidate. Capture iPhone 6.5-inch and 13-inch iPad variants of: Today, Apple Health provider detail with clinical-record controls, Clinical Records list, and a Clinical Record detail. The media set must show the current UI and real feature flows, not splash, login, or promotional-only artwork. Apple requires screenshots and previews to accurately reflect the app's core experience. [Apple: App Review Guidelines 2.3](https://developer.apple.com/app-store/review/guidelines/)

## Privacy, Access, and Retention

Clinical data is transmitted over TLS to Dofek's authenticated API and stored in the account-scoped PostgreSQL clinical-record table. It is accessible only to the account holder through authenticated API calls and to narrowly authorized operators for production support under existing access controls. It is not sold, used for advertising, or shared with other users. Sentry and analytics events must not include FHIR payloads or clinical values.

FHIR payloads are retained until the user deletes the Apple Health provider data or deletes the account. Account erasure follows the repository's existing Postgres, ClickHouse, archive, and local-device cleanup workflow.

## Testing and Acceptance Criteria

- Native XCTest proves each supported clinical type maps an `HKClinicalRecord` into the typed bridge contract, including the OS-gated clinical-note type.
- Unit tests prove client batching and server validation/upsert behavior.
- PostgreSQL integration tests execute the migration and validate backfill, per-user isolation, provider-data deletion, and account erasure against a real database.
- Mobile and web component/route tests prove loading, error, empty, list, and detail states consume server-authored values.
- A physical iPhone verifies the actual HealthKit authorization and query flow; the simulator cannot be used as proof of Clinical Health Records behavior.
- Native iPhone and iPad screenshot artifacts are reviewed against final-build UI before App Store Connect upload.

## Non-Goals

- Clinical interpretation, diagnosis, treatment recommendations, or alerts.
- Writing, correcting, or deleting records in HealthKit.
- Background clinical-record syncing.
- Separate per-type persistence tables or any duplicated clinical source of truth.
