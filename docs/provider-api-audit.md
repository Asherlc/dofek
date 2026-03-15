# Provider API Audit: Reverse Engineering Feasibility

An assessment of every provider we considered reverse engineering, documenting what the official API provides, what gaps exist, and whether reverse engineering is feasible or worthwhile.

Last updated: 2026-03-14

---

## Reverse Engineered (done)

### Garmin Connect
- **Package:** `packages/garmin-connect`
- **Official API:** Garmin Health API (OAuth 2.0, developer program) — limited to activities, sleep, daily summaries, body composition
- **Internal API:** 105+ endpoints at `connect.garmin.com` via SSO auth (5-step: embed → CSRF → login → OAuth1 ticket → OAuth2)
- **Gaps filled:** HRV (nightly readings + baseline), body battery (charge/drain time series), stress (per-minute), training readiness, training status/load, race predictions, endurance/hill scores, fitness age, SpO2 time series, FIT/TCX/GPX downloads
- **Source:** Based on [garth](https://github.com/matin/garth) and [python-garminconnect](https://github.com/cyberjunky/python-garminconnect)
- **Verdict:** HIGH VALUE — massive data gap between official and internal API

### WHOOP
- **Package:** `packages/whoop-whoop`
- **Official API:** WHOOP Developer API (limited, partner access)
- **Internal API:** Cognito-based auth, REST endpoints for cycles, recovery, sleep, workouts, weightlifting
- **Gaps filled:** Weightlifting service (exercise-level sets/reps/weight), cycle data at higher resolution
- **Verdict:** HIGH VALUE — weightlifting data only available via internal API

### Eight Sleep
- **Package:** `packages/eight-sleep`
- **Official API:** None
- **Internal API:** Hardcoded client credentials extracted from APK, REST at `client-api.8slp.net/v1`
- **Data:** Sleep trends (HR, HRV, respiratory rate, temperature, sleep stages), bed temperature controls
- **Verdict:** ONLY OPTION — no public API exists

### Zwift
- **Package:** `packages/zwift-client`
- **Official API:** None (partner-only)
- **Internal API:** Keycloak OAuth password grant, REST at `us-or-rly101.zwift.com/api`
- **Data:** Activities with power/HR/cadence streams, fitness data (FTP, weight)
- **Key quirk:** All measurements in centimeters (speed in cm/s, altitude in cm, weight in grams)
- **Source:** Based on [rally25rs/zwift-api-wrapper](https://github.com/rally25rs/zwift-api-wrapper)
- **Verdict:** ONLY OPTION — no public API exists

### TrainerRoad
- **Package:** `packages/trainerroad-client`
- **Official API:** None
- **Internal API:** CSRF cookie-based form login, REST at `www.trainerroad.com/api`
- **Data:** Activities with power data, career stats, workout history
- **Verdict:** ONLY OPTION — no public API exists

### VeloHero
- **Package:** `packages/velohero-client`
- **Official API:** None (has a simple SSO-based web API)
- **Internal API:** Session token via SSO POST, REST at `app.velohero.com`
- **Data:** Workouts with HR/power/cadence, sport type mapping
- **Source:** Based on [tapiriik](https://github.com/cpfair/tapiriik)
- **Verdict:** ONLY OPTION — SSO API is the only programmatic access

### TrainingPeaks
- **Package:** `packages/trainingpeaks-connect`
- **Official API:** Partner-only (requires approval, personal use blocked). Metrics are write-only. No CTL/ATL/TSB.
- **Internal API:** Cookie-based auth (`Production_tpAuth` → Bearer token exchange), REST at `tpapi.trainingpeaks.com`
- **Gaps filled:** Performance Management Chart (CTL/ATL/TSB), read metrics, personal records, workout analysis with time-series channels
- **Auth limitation:** No programmatic login — user must provide cookie from browser session. Cookie refreshable via `home.trainingpeaks.com/refresh`.
- **Key quirk:** `totalTime` in decimal hours (1.25 = 1h15m), 90-day max query range
- **Source:** Based on [freekode/tp2intervals](https://github.com/freekode/tp2intervals) and [JamsusMaximus/trainingpeaks-mcp](https://github.com/JamsusMaximus/trainingpeaks-mcp)
- **Verdict:** HIGH VALUE — PMC data and readable metrics unavailable through partner API

---

## Not worth reverse engineering

### Fitbit
- **Official API:** Surprisingly comprehensive — 1-second HR, 30-second sleep stages, SpO2 intraday, HRV, ECG, temperature, active zone minutes, VO2 max
- **Internal API:** Does not exist separately. The web dashboard uses the same `api.fitbit.com` endpoints as the public API.
- **Gaps:** Stress Management Score, EDA (electrodermal activity), Daily Readiness Score — genuinely unavailable programmatically, only via manual Google Takeout export
- **API status:** NOT being deprecated (Google Fit API is, but that's separate). Being updated through 2025+.
- **Note:** Intraday data requires "Personal" app type registration
- **Verdict:** NO RE NEEDED — official API is excellent. The few gaps (stress, EDA, readiness) aren't exposed anywhere, not even internally.

### Polar
- **Official API:** AccessLink API v3 — exercises with Training Load Pro, Nightly Recharge with HRV, sleep stages, cardio load, continuous HR (5-min intervals)
- **Internal API:** `flow.polar.com` uses cookie-based session auth, but it's a traditional server-rendered web app (not a clean REST API). Most scrapers need Selenium.
- **Gaps:** Orthostatic test results (no endpoint anywhere), running power (not in response schema), 28/30-day lookback limit
- **Extended content:** Detailed HRV 5-min averages and sleep hypnograms available by applying to Polar Research Center
- **Community projects:** [campbellr/flow-client](https://github.com/campbellr/flow-client) (archived 2021), [pcolby/bipolar](https://github.com/pcolby/bipolar) (old FlowSync era)
- **Verdict:** NO RE NEEDED — official API covers most data. Internal web API is fragile (server-rendered pages). Gaps are small (orthostatic tests, running power).

### Oura
- **Official API:** Oura Cloud API v2 — 17 endpoint groups: sleep (5-min stage resolution), HR (individual timestamped readings), HRV (5-min intervals), readiness, resilience, stress (daily aggregate), SpO2 (daily aggregate), VO2 max, cardiovascular age, workouts
- **Internal API:** Web portal at `cloud.ouraring.com` exists but no one has documented its internal endpoints
- **Gaps:** SpO2 time-series (app shows overnight graph, API gives daily average), stress time-series (app shows daytime graph, API gives daily totals), cycle/period tracking, ring battery (BLE only)
- **RE efforts:** Only BLE protocol RE exists ([ringverse/protocol](https://github.com/ringverse/protocol)), not cloud API
- **Note:** Active membership ($5.99/mo) required for API access on Gen 3/Ring 4
- **Verdict:** LOW VALUE RE — official API is solid. Gaps (SpO2/stress time-series, cycle tracking) are real but niche.

### Samsung Health
- **Official API:** No public REST API. Samsung charges ~$10K for server-side access. On-device SDK deprecated July 2025, replaced by Samsung Health Data SDK (foreground Android app only).
- **Internal API:** Proprietary Samsung Cloud sync protocol. No one has published a reverse-engineered client. No web portal exists.
- **Data locked behind:** Mobile app only. Health Connect bridge is Android-only, foreground-only, and missing body composition, ECG, stress, Energy Score.
- **Export options:** Manual CSV export from app, or build a dedicated Android companion app using Samsung Health Data SDK
- **Verdict:** NOT FEASIBLE — no web surface to target, no community RE work, would require Android companion app (different architecture entirely).

---

## Summary matrix

| Provider | Official API Quality | RE Feasibility | RE Value | Status |
|----------|---------------------|----------------|----------|--------|
| Garmin Connect | Limited | Easy (well-documented) | Very high | Done |
| WHOOP | Limited/partner-only | Medium (Cognito) | High | Done |
| Eight Sleep | None | Easy (hardcoded creds) | Essential | Done |
| Zwift | None | Easy (Keycloak) | Essential | Done |
| TrainerRoad | None | Medium (CSRF cookies) | Essential | Done |
| VeloHero | None | Easy (SSO) | Essential | Done |
| TrainingPeaks | Partner-only | Easy (cookie → Bearer) | High | Done |
| Fitbit | Excellent | N/A (no internal API) | None | Skip |
| Polar | Good | Low (server-rendered) | Low | Skip |
| Oura | Good | Unknown (undocumented) | Low | Skip |
| Samsung Health | None (on-device only) | Very hard (no web surface) | N/A | Skip |
| Peloton | Decent | Unknown | Medium | Not investigated |
| Withings | Decent | Unknown | Medium | Not investigated |
