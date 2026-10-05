# Page data loading acceptance

Correct requested data must be visible in less than **1000 ms** from navigation
or the filter input event. A shell, skeleton, empty response for a populated
fixture, stale range, or mounted but unfinished chart is not completion.
The [approved design](../superpowers/specs/2026-10-02-subsecond-page-loading-design.md)
defines the data, isolation, and freshness requirements. The
[October audit](production-load-audit-2026-10-02.md) is the historical baseline,
not evidence that the new code meets this target.

## Measurement contract

Each route declares required sections before they mount, including conditional
sections. A local generation starts at navigation time origin (`0` on the
document's performance clock), the client navigation input event, or the filter
input event. A replacement operation cancels the earlier generation. Old and
duplicate callbacks cannot complete the current operation. A section completes
with current rendered data, a genuine empty state, or an error. All required
sections must complete; all-empty pages report empty, mixed pages report ready,
and errors/cancellation never count as success.

DOM consumers report after commit and two animation-frame callbacks, providing
an intervening paint opportunity. This does not prove canvas pixel completion:
chart consumers must use renderer completion tied to their result/option
generation. User Timing supports explicit start/end timestamps and local
metadata ([W3C User Timing](https://www.w3.org/TR/user-timing/)); frame callbacks
run before a repaint ([MDN requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)).

Successful page outcomes produce a browser PerformanceMeasure named
`dofek.page.data-ready`. Errors/cancellation produce `dofek.page.data-outcome`.
The detail contains only route template, interaction kind, outcome, and local
generation. Read these entries with `performance.getEntriesByName` or Chrome's
Performance panel; no global diagnostic object is installed. Keep raw traces,
record identifiers, account data, and date/range inputs in ignored local evidence.

The existing consent-gated PostHog export, `page_data_readiness`, includes only
route, optional section, kind, durationMs, outcome, and release as measurement
properties. SDK transport metadata retains the public project token, event UUID,
optional timestamp, existing device ID as `distinct_id`, and
`$process_person_profile: false`. The readiness-specific `before_send` filter
removes raw account IDs, URLs/query strings/referrers, health values, request
keys, and profile updates. Other analytics events retain their existing policy.
The device ID is transport metadata, **not an anonymity guarantee**: existing
profile associations remain associated ([PostHog anonymous/identified events](https://posthog.com/docs/data/anonymous-vs-identified-events)).
Missing SDK device identity reports an error through existing telemetry and
drops this export; it does not manufacture an ID. Erasure and opt-out keep
exports disabled. Browser-local timing remains available without analytics
consent, as required by the design.

## Current instrumentation coverage

Dashboard declares `cards`, `health`, `insights`, `resting-heart-rate`, and
`processing`. Cards, health, processing, and genuine-empty insights are DOM
consumers. Populated insights remain pending until renderer completion is wired.
Resting-heart-rate remains pending even when its query is empty: the existing
ChartContainer can still show a global-fetch spinner. Task 9 must replace that
dependency and supply its actual rendering/empty callback. Dashboard therefore
cannot currently emit successful whole-page completion.

Daily Heart Rate declares `chart` and `sources`. Its summary table and genuine
empty/error states are DOM consumers. Date controls begin a new generation at
the input timestamp. A populated source chart remains pending until Task 9
attaches renderer completion. Empty daily results can complete honestly now.
Other inventory routes are acceptance scope, not yet instrumented consumers.
Native timing is separate from this mobile-web target; matching native refresh
behavior is validated with the subsequent cross-platform client tasks.

## Fixture inventory

Each populated fixture must include every listed section; each empty fixture
must exercise the real empty/insufficient/unavailable contract. Fixtures must
use isolated users and independently expected server values. IDs stay in
ignored evidence. Owners below refer to files under `packages/web/src/` and
identify the route/page responsible for adding section completion.

| Audit view | Route / owner | Required sections | Populated / empty fixture | Filter inputs |
|---|---|---|---|---|
| Dashboard | `/dashboard`, pages/Dashboard | cards, health, insights, resting-heart-rate, processing | cards + delayed insight + trend / completed empty insight and trend | current end date |
| Activities | `/activities`, pages/ActivitiesPage | summary, activity list, processing | multiple sports + pages / no activities | 4→8 weeks, sport, pagination |
| Sleep | `/sleep`, pages/SleepPage | sessions, charts, sleep need, processing | sessions + need / no sessions | finite range, All |
| Body | `/body`, pages/BodyPage | vitals, six charts, insights | sensor + weight history / sparse and empty | finite range, All, trend metric |
| Nutrition / food log | `/nutrition`, pages/NutritionPage | entries, daily totals, source state | canonical food entries / no entries | adjacent date, range |
| Training | `/training`, routes/training/index | cards, calendar, volume, activities, seven charts including HR zones, processing | multisport sensor history / no training | 90→30 days, All |
| Data Sources | `/providers` → settings, pages/SettingsPage | provider cards, sync history | connected providers / no providers | settings category |
| Correlation | `/correlation`, pages/CorrelationExplorerPage | controls, observations, computed result | sufficient paired history / insufficient history | metric pair, range |
| Health Report list | `/health-report`, routes/health-report | report list | existing report / no reports | list selection |
| Running | `/training/running`, routes/training/running | trends, dynamics, pace curve, activities | running samples / no runs | range, All |
| Cycling | `/training/cycling`, routes/training/cycling | power/efficiency charts, activity table | cycling power + HR / no rides | range, All |
| Strength | `/training/strength`, routes/training/strength.lazy | metrics, exercises, activities | strength records / no sessions | range, All |
| Recovery | `/training/recovery`, routes/training/recovery | recovery cards, charts | recovery history / insufficient history | range, All |
| Climbing training | `/training/climbing`, routes/training/climbing | analytics, activity list | climbs + attempts / no climbs | range, All |
| Hiking | `/training/hiking`, routes/training/hiking | analytics, available empty states, activities | hiking tracks / no hikes | range, All |
| Endurance | `/training/endurance`, routes/training/endurance | analytics, activities | endurance samples / no activities | range, All |
| Daily Heart Rate | `/body/heart-rate`, pages/DailyHeartRatePage | chart, sources | multiple raw provider series / no samples | adjacent days, date, Today |
| Nutrition Analytics | `/nutrition/analytics`, pages/NutritionAnalyticsPage | TDEE, micronutrients, macro ratios | intake + body-weight history / insufficient data | range, All |
| Supplements | `/nutrition/supplements`, routes/nutrition/supplements | stack, safety information | active supplement versions / empty stack | date |
| Experiments | `/experiments`, pages/PersonalExperimentsPage | list, conditional detail | existing experiment / no experiments | experiment selection |
| Tracking | `/tracking`, pages/TrackingPage | current tracking state | tracked observations / empty state | date/range |
| Weekly Report | `/weekly-report`, routes/weekly-report | report content | populated week / insufficient week | week |
| Monthly Report | `/monthly-report`, routes/monthly-report | report content | populated month / insufficient month | month |
| Behavior Impact | `/behavior-impact`, routes/behavior-impact | impact result | sufficient observations / insufficient state | range, behavior |
| Cycle | `/cycle`, routes/cycle | history, phase state | cycle observations / no observations | range |
| Settings default | `/settings`, pages/SettingsPage | selected category content | saved settings / defaults | category |
| Alerts | `/alerts`, pages/AlertsPage | alert list | active alerts / no alerts | selection |
| Clinical Records | `/clinical-records`, pages/clinical-records | list, conditional detail | clinical record / no records | record selection |
| More | `/more`, pages/MorePage | navigation DOM | navigation / same static content | none |
| Developer Integrations | `/developer-integrations`, pages/DeveloperIntegrationsPage | integration list | registered integration / empty list | integration selection |
| Admin overview | `/admin`, pages/AdminPage | overview | isolated admin fixtures / zero totals | category |
| Walking activity detail | `/activity/$id`, pages/ActivityDetailPage | summary, two charts | walking sensor activity / sparse activity | activity selection |
| Running activity detail | `/activity/$id`, pages/ActivityDetailPage | summary, charts, map | running activity + route / no route | activity selection |
| Climbing activity detail | `/activity/$id`, pages/ActivityDetailPage | summary, climbs, suggested ticks | climbing activity + dependent climbs / no attached climbs | activity selection |
| Cycling activity detail | `/activity/$id`, pages/ActivityDetailPage | summary, sensor charts, map, HR and power zones when available | cycling activity with power + route / missing power or route | activity selection |
| Strength activity detail | `/activity/$id`, pages/ActivityDetailPage | summary, exercise and set details | recorded strength sets / no sets | activity selection |
| Hangboarding activity detail | `/activity/$id`, pages/ActivityDetailPage | summary, hangboard details | recorded hangboard session / unavailable details | activity selection |
| Public landing | `/`, pages/LandingPage | public content, provider labels | public provider catalog / unavailable catalog state | none |

The user explicitly reaffirmed Activities list and Activity detail performance
on October 3. Their target is the same <1,000 ms until all relevant selected
data is displayed. Include direct entry, list-to-detail navigation, switching
activities, list range/sport/pagination changes, and conditional sport sections.
The additional cycling, strength, and hangboarding detail rows are acceptance
scope rather than previously measured audit results; missing populated fixtures
remain explicit validation gaps. Apply equivalent native behavior and validation.

The audit's mobile rows reuse Dashboard, Activities, Training, Sleep, Nutrition,
Data Sources, Correlation, and Running above; its public warm traces add `/login`
(routes/login: authentication methods/form). Legacy `/insights` and
`/predictions` redirects use Body completion. Audit interaction rows are covered
by Heart Rate adjacent-day, Training 90→30-day, Activities 4→8-week filters,
cached Training/Activities navigation, and first in-app Sleep navigation.
Public legal/support/reset flows, provider details, all admin categories,
populated clinical/experiment detail, and shared report tokens remain the
audit's explicitly unmeasured scope; they are not silently treated as passes.

## Acceptance runs and evidence

Repeat every inventory row with populated and empty fixtures in Chrome at
1440×1000 without throttling and 390×844, scale factor 3, Fast 4G and 4× CPU.
Separate cold browser (empty HTTP/asset/service-worker caches, valid isolated
session), first data query, confirmed server cache hit/miss, warm full revisit,
first in-app navigation, cached return, and filter operations. Unobservable
cache status is unknown. Do not flush production caches to manufacture misses.

Collect **at least five observations per scenario**. Retain every result and
failure, including errors, cancellations, timeouts, and missing completion
markers; do not discard slow runs. Every successful required result must be
**less than 1000 ms**; a mean, median, or fastest sample below the budget does
not establish acceptance. These observation and pass rules come from the
[approved acceptance contract](../superpowers/specs/2026-10-02-subsecond-page-loading-design.md#reference-profiles-and-cache-states).

Record release, route template, fixture label, viewport/throttle/cache state,
operation, duration, outcome, rendered sections, and independent freshness/parity
evidence. Verify a new observation and deletion become visible under the existing
freshness contract; preserve labels on stale content during refresh. Check
errors, user changes, out-of-order responses, and conditional late mounts.

Use the existing Cypress login and isolated fixture seeding for browser
regressions. `cypress/e2e/page-data-readiness.cy.ts` delays the real Daily Heart
Rate response and checks genuine-empty visibility before accepting its marker.
This is empty-data readiness evidence, not populated-chart acceptance. Task 9
must add populated renderer/late-section browser evidence. Keep global CI free
of a failing one-second timing threshold until production acceptance is complete.
Inspect a separate Chrome trace with the marker and actual rendering, following
[Chrome Performance](https://developer.chrome.com/docs/devtools/performance).

The current production target remains unverified. Historical audit failures
include >20-second fresh Heart Rate/pace curve/HR-zone waits, 4.32-second mobile
Dashboard, 5.69-second mobile Data Sources, 16.89-second Heart Rate filtering,
and 7.31-second Training filtering; these retain their original caveats and
are not reruns of this instrumentation.
