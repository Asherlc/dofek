# Body metrics decision context

The Body page and mobile Recovery tab show the server-authored context needed to
interpret Trend Weight and recent scale readings. The context is derived from
the existing ClickHouse body-measurement view; it does not create a second
source of body data.

## Measurement provenance

The latest positive body measurement selected for the user’s local calendar day
is shown with its provider, optional device/source name, weight, and recorded
clock time in the configured user timezone. The display encourages comparable
measurements: [NHS England recommends recording weight at the same time of day
and using the same scales](https://www.england.nhs.uk/long-read/how-to-record-your-weight/).

## Trend Weight contract

Trend Weight uses the existing server-side EWMA with alpha `0.1`:

- each selected daily scale reading moves the trend 10% toward that reading;
- missing days between readings are linearly interpolated;
- non-positive weights are excluded from the trend input;
- readings are not removed as outliers.

The exact contract is returned with the body analytics response so web and
mobile render the same explanation.

## Personalized typical measurement variation

The server computes scale-to-Trend-Weight residuals for the latest 30 selected
daily readings. It reports an informational residual band after at least eight
readings using Tukey inner fences (`Q1 - 1.5 × IQR` and `Q3 + 1.5 × IQR`). The
band is not a clinical threshold, and outlying readings remain included in the
underlying data. This follows the standard boxplot inner-fence definition
described by [NIST’s outlier guidance](https://www.itl.nist.gov/div898/handbook/prc/section1/prc16.htm).

When fewer than eight actual readings are available, the response explicitly
returns an insufficient-data state instead of inventing a range.
