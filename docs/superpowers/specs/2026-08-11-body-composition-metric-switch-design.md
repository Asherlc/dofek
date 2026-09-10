# Body Composition Metric Switch Design

## Goal

Let people switch the existing body-composition trend surface between Trend Weight and Body Fat on web and mobile.

## Chosen approach

Replace each platform's adjacent Trend Weight and Body Fat cards with one card containing an accessible local metric switch. Weight is selected initially. The switch changes only client rendering: it selects existing server-authored weight or body-fat series, values, units, and explanatory content.

## Alternatives considered

1. A single switchable card (chosen): keeps related measurements in one place without changing API contracts.
2. Separate cards: preserves the current layout but does not satisfy the request for a switchable trend surface.
3. A server-owned selected metric: unnecessary state and network work for a view preference that has no meaning outside the current screen.

## Platform behavior

- Web: replace the separate Trend Weight and Body Fat Percentage cards in Body Composition with one `Trend` card and a Weight / Body Fat control. Weight retains the existing smoothed chart, prediction, and decision context. Body Fat renders the existing percentage chart.
- Mobile: replace the adjacent Trend Weight and Body Fat % cards on Recovery with one card and the same control. Weight retains its value, sparkline, prediction, and decision context. Body Fat retains its value, accessible body-fat trend label, and sparkline.
- The selected value is local, starts as Weight on each screen mount, and does not alter server data or mutation state.

## Error handling and accessibility

Existing loading, unavailable, and empty behavior remains unchanged. The metric switch uses platform-native accessible controls and exposes the selected state to assistive technology.

## Tests

Web and mobile screen tests will first demonstrate that selecting Body Fat hides the weight presentation and reveals the existing body-fat presentation. Existing chart/component tests continue to protect chart semantics.
