# Altitude Provenance

This note records what the app can and cannot know about altitude samples from
current providers. It is intentionally conservative: do not label an altitude
sample as GNSS, barometric, map-derived, or fused unless the provider or file
format gives explicit provenance for that specific sample or stream.

## Current Storage

The canonical time-series table stores altitude as `metric_stream` rows with
`channel = 'altitude'` and `scalar` in meters. Horizontal GPS position is stored
as a `metric_stream` row with `channel = 'location'`, `point` as
`geometry(Point, 4326)`. ClickHouse mirrors the canonical point and projects
latitude/longitude only in read models. Elevation gain/loss is not stored as
canonical raw data; ClickHouse read models derive it from deduped altitude
deltas.

This means the database currently preserves the altitude value, provider, source
type, activity, timestamp, and optional device/source name. It does not preserve
an explicit altitude-source classification such as `barometer`, `gnss`, `dem`,
or `sensor_fusion`.

## Provider And Format Findings

| Source | Ingest path | What we store | What provenance we can know |
|---|---|---|---|
| Apple Health workout routes | Health export `Location` elements and mobile HealthKit route sync | Location as `channel = 'location'`; altitude and speed as separate metric rows; `horizontalAccuracy` as location metadata `horizontal_accuracy_m` | Unknown. Apple/Core Location models a location as coordinate plus altitude and accuracy values, but our route payload does not include `CLLocationSourceInformation` or a source-specific altitude origin. Treat as Apple-provided location altitude, not necessarily GNSS. |
| FIT files: Wahoo, COROS, Suunto | Download provider FIT file, parse `enhanced_altitude ?? altitude`; parse `gps_accuracy` when present | FIT record altitude in meters, preferring `enhanced_altitude`; FIT GPS accuracy as location metadata `gps_accuracy_m` | File-level altitude source unknown. FIT is a transport format for device data; `enhanced_altitude` is a higher-resolution altitude field, not a provenance field. FIT `gps_accuracy` is explicitly a meter-valued `uint8` field in the official profile, but the profile does not define whether it is a horizontal radius, CEP, one-sigma error, or another vendor-specific confidence metric. Device/vendor docs may tell us likely behavior for a given device family, but the record itself does not prove source. |
| Wahoo ELEMNT FIT files | Same FIT path | Altitude from FIT record | Likely GPS-adjusted barometric for ELEMNT/BOLT/ROAM recordings. Wahoo documents those devices as primarily using a barometric altimeter and using GPS to adjust drift. Still store as unknown unless we add device-aware provenance. |
| COROS FIT files | Same FIT path | Altitude from FIT record | Likely barometer plus GPS calibration/fusion for COROS devices that support elevation. COROS documents barometer readings with periodic GPS calibration and possible GPS override. The FIT record we ingest does not expose the per-sample decision. |
| Suunto FIT files | Same FIT path | Altitude from FIT record | Device-dependent. Suunto documents FIT export as containing measured altitude and says some barometric products combine GPS and barometer through FusedAlti. The exported record does not tell us whether a given sample is GPS-only, barometric, or fused. |
| Strava streams | `altitude` stream from activity streams endpoint | Stream altitude in meters | Mixed and not explicit in API response. Strava documents that activities from known barometric devices use device-recorded barometric elevation, while non-barometric/GPS-source elevation can be cross-referenced to Strava's elevation basemap. The stream payload does not include a provenance flag, and users can request correction on the web. |
| Garmin Connect detail API | `directElevation` samples from unofficial activity detail | Direct elevation in meters | Device/account-dependent. Garmin documents that devices with barometric altimeters record elevation from air-pressure changes, while devices without barometric altimeters can use Garmin Connect/professional survey/DEM-style elevation. The unofficial sample field does not expose which source was used. |
| Ride with GPS trips | `track_points[].e` | Track-point elevation in meters | Unknown/provider-processed. Dofek stores the API value without per-sample provenance. Ride with GPS says activity elevation may originate from barometric or GPS measurements and can be replaced with its elevation dataset, so `e` does not prove the original sensor or processing path. |
| Fitbit and Polar TCX | Download TCX, parse `AltitudeMeters` | Trackpoint altitude in meters | Unknown from TCX. The TCX schema carries `AltitudeMeters` but no source. Fitbit/Polar device capabilities vary, so any source classification would need device-specific metadata we do not currently store. |
| Zwift | Fitness data `altitudeInCm` | Virtual altitude in meters | Virtual/course-derived, not real-world GNSS or barometer. Zwift activities are virtual routes; altitude is part of the simulated route/fitness data. |
| Komoot, Xert, Cycling Analytics, TrainerRoad summaries | Activity summary raw JSON only | Summary elevation gain/loss in `activity.raw`, not canonical altitude stream | Summary provenance is provider-defined and not used as canonical altitude samples. Do not infer per-sample altitude source from these summary values. |

## External References

- Apple Core Location `CLLocation`: location objects contain geographical
  location, altitude, accuracy, timestamp, and source information, but our route
  sync does not persist source information:
  <https://developer.apple.com/documentation/CoreLocation/CLLocation>
- Garmin FIT SDK overview: FIT stores and transfers sport/fitness/health device
  data, and `Profile.xlsx` is the most up-to-date reference for predefined FIT
  messages:
  <https://developer.garmin.com/fit/overview/>
- Garmin FIT SDK tools profile: the current `Profile.xlsx` defines
  `gps_accuracy` as a `uint8` field with units `m` on the `record` message
  (field definition 31), and also on `session`, `lap`, and `segment_lap`
  messages. It does not include a comment defining the statistical meaning:
  <https://github.com/garmin/fit-sdk-tools>
- Garmin elevation source behavior: Garmin documents barometric-altimeter
  devices as recording elevation from pressure changes, while devices without a
  barometric altimeter rely on Garmin Connect elevation data from survey/DEM-like
  sources:
  <https://support.garmin.com/en-CA/?faq=dRY70Lc6yv2oY3eam1ZWxA>
  and <https://support.garmin.com/en-IN/?faq=R4I5hFFcUk8gJPC4zi0Xv6>
- Wahoo ELEMNT elevation behavior: ELEMNT/BOLT/ROAM primarily use a barometric
  altimeter and GPS adjustment:
  <https://support.wahoofitness.com/hc/en-us/articles/115000441324-Why-are-there-Elevation-differences-in-my-ride-data>
- COROS elevation behavior: COROS documents GPS plus internal barometer
  elevation calculation, with barometer readings and periodic GPS calibration:
  <https://support.coros.com/hc/en-us/articles/11432277964052-How-COROS-Devices-Measure-Elevation>
- Suunto FIT/FusedAlti notes: Suunto documents FIT export for workouts and
  describes some products as combining GPS and barometric altitude through
  FusedAlti:
  <https://www.suunto.com/Support/faq-articles/suunto-app/what-type-of-files-can-i-export-from-the-suunto-app/>
  and
  <https://apizone.suunto.com/fit-description>
- Strava elevation behavior: Strava documents barometric-device elevation,
  corrected elevation from GPS plus its elevation basemap, and different mobile
  live-elevation behavior by platform:
  <https://support.strava.com/en-us/articles/15401909-elevation>
  and
  <https://support.strava.com/en-us/articles/15401823-strava-s-elevation-basemap>
- Ride with GPS track points and elevation processing: the live OpenAPI
  specification defines trip track points, while current support docs explain
  device elevation, provider smoothing, and replacement from the provider's
  elevation dataset:
  <https://ridewithgps.com/api/v1/openapi.yaml>,
  <https://support.ridewithgps.com/hc/en-us/articles/4419010957467-Grade-Elevation-and-GPS-Accuracy-FAQ>,
  and
  <https://support.ridewithgps.com/hc/en-us/articles/4444266900763-Replace-Elevation>
- Fitbit GPS/elevation-related behavior: Fitbit documents GPS capture modes and
  barometric altimeters for floor counting, but TCX altitude source is not
  exposed in our ingest:
  <https://support.google.com/fitbit/answer/14225688>
  and <https://support.google.com/fitbit/answer/14237111>

## Modeling Implications

Altitude should be treated as an associated vertical measurement, not as an
intrinsic part of a 2D GPS point. Horizontal position is a point-valued metric in
`metric_stream`, while altitude remains a scalar metric unless there is a
concrete need for 3D GIS operations.

Do not automatically map FIT `gps_accuracy` into a field named
`horizontal_accuracy_m`. FIT gives us a meter-valued GPS accuracy number, but not
the same semantics as Apple/Core Location `horizontalAccuracy`. If we introduce a
new location metadata field, keep Core Location/Expo horizontal accuracy
separate from FIT GPS accuracy unless a provider gives a stronger field-level
definition.

During the PostGIS location migration, legacy `lat`, `lng`, and `gps_accuracy`
metric-stream rows are removed after `location` rows are backfilled. Matched FIT
`gps_accuracy` values move to `location.metadata.gps_accuracy_m`; unmatched
legacy `gps_accuracy` rows are discarded because they cannot be attached to a
valid point-valued location sample.

If altitude provenance becomes product-relevant, add an explicit nullable field
or channel metadata value with a small enum such as:

- `barometer`
- `gnss`
- `map_elevation`
- `sensor_fusion`
- `provider_processed`
- `virtual_course`
- `unknown`

Backfill existing real-world altitude samples to `unknown` unless there is
device-specific evidence strong enough to justify a more precise label. Zwift can
be labeled `virtual_course` because the activity is simulated. Provider summary
elevation gain/loss should remain separate from sample-level altitude provenance.
