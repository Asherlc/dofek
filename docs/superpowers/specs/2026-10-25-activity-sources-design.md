# Activity sources consolidation

Use the existing device/provider inheritance tree as the activity detail's single
Sources disclosure on web and mobile. The user approved this direction and asked
for screenshots of the result.

Show device facts beneath the device node, associating the hardware's
`activityId` with stable record/attribution IDs. Reported hardware becomes a
child of its reporting provider, including Peloton → WHOOP. Retain unmatched
hardware as an independent provider branch inside the disclosure. Keep loading, cached data, error, and retry
states accessible. Use tree parentage to show who reported hardware; omit repeated recording
attribution, recording-source, and other-matching-source captions. Retain device identities and facts without
asserting that a reported category proves recording origin.

The alternative, clarifying two separate sections, preserves the duplicated
source presentation and was declined. No ingestion or stored provenance changes
are needed. The existing native disclosure button retains expansion state,
keyboard activation, and controlled content, following the
[WAI disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/).

Specific Apple Watch models come from retained HealthKit source product types,
with no generic “Watch” model row. Existing uploads missing that raw identifier
need a fresh sync; see Apple’s [productType contract](https://developer.apple.com/documentation/healthkit/hksourcerevision/producttype).
