# Human-readable device names

The approved direction is a bundled device catalog and shared resolver for web
and mobile. Device headings, models, source disclosures, and metric pickers
should show recognizable names while retaining source identities in stored raw
records. The user's final direction removes product codes and raw model/hardware
identifiers from displayed Details. Custom reported names remain useful evidence. Unknown identifiers
must not acquire an invented model or variant.
Recorded devices omit the redundant recording-source subtitle; sensor and FIT
file-creator roles remain qualified because they convey different evidence.

Use a snapshot of the maintained [AppleDB device catalog](https://github.com/littlebyteorg/appledb/blob/main/API.md)
with its [MIT attribution](https://github.com/littlebyteorg/appledb/blob/main/LICENSE).
Cover public Apple Watch, iPhone, iPad, and iPod touch models; exclude internal
devices. `Watch6,9` resolves to `Apple Watch Series 7 (GPS + Cellular, 45mm)`.
Reuse the existing [Garmin FIT profile](https://github.com/garmin/fit-javascript-sdk/blob/main/src/profile.js)
for manufacturer-specific numeric products and normalize symbolic names such
as `fr955` to `Forerunner 955`. Other manufacturers keep reported product names
or a known manufacturer/device category when a product is unknown.

A local catalog avoids adding a runtime network dependency. Live lookup was
considered but rejected in favor of the approved bundled approach. A small
handwritten Apple list would omit devices; a complete upstream snapshot is
preferred. Garmin Connect IQ names cannot establish a more specific edition
than the FIT evidence, so do not infer editions from thumbnail aliases.

No storage migration or ingestion changes are needed. Preserve device IDs,
provider attribution, source ordering, and default chart selections. Test both
client disclosures with the same resolved names and useful personal names/version facts.
