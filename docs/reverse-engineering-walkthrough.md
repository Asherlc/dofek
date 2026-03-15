# How to Reverse Engineer an API: A Complete Walkthrough

A step-by-step guide for going from "this app has data I want" to "I have a working TypeScript client that can fetch it." Written from experience building clients for WHOOP, Eight Sleep, Zwift, TrainerRoad, VeloHero, and Garmin Connect.

## Phase 1: Reconnaissance

Before writing any code, spend time understanding what you're dealing with.

### 1.1 Check if someone already did the work

This should always be your first step. Search GitHub before you do anything else.

```
"<service name> api" site:github.com
"<service name>" unofficial client
"<service name>" reverse engineer
"<service name>" api wrapper python OR typescript OR javascript
```

Also check:
- [tapiriik](https://github.com/cpfair/tapiriik) — fitness aggregator with integrations for dozens of services
- Reddit threads (r/quantifiedself, r/fitness, service-specific subreddits) — people often share API findings
- The service's own community forums — developers sometimes discuss API access

**Why this matters:** We saved days of work on Zwift (rally25rs had documented everything), VeloHero (tapiriik had the SSO flow), and Garmin Connect (garth + python-garminconnect had 100+ endpoints mapped).

### 1.2 Determine what the app actually shows

Before you start intercepting traffic, make a list of every piece of data the app displays. This becomes your target list. Open the app and screenshot every screen.

For a fitness app, this usually includes:
- Activity list with summaries
- Activity detail view (HR, power, cadence, GPS, laps)
- Daily health metrics (steps, HRV, stress, body battery)
- Sleep breakdown (stages, scores, SpO2)
- Training load / readiness / recovery scores
- Body composition
- Settings / profile (units, timezone, connected devices)

Compare this to the official API (if one exists). Every piece of data that's in the app but not in the official API is a reason to reverse engineer.

### 1.3 Decide your approach

| Situation | Best approach |
|-----------|--------------|
| Service has a web app | Browser DevTools network inspection |
| Mobile-only app, not obfuscated | APK decompilation with jadx |
| Mobile-only, heavily obfuscated | mitmproxy traffic interception |
| Someone already wrote a client | Read their code and port to TypeScript |
| All of the above are blocked | Give up, try CSV export or screen scraping |

In practice, you'll often combine multiple approaches. Start with the easiest one that gives results.

## Phase 2: Mapping the auth flow

Authentication is always the hardest part. Get this right first, because nothing else works without it.

### 2.1 Capture the login sequence

**Browser DevTools approach:**
1. Open the service's web app in Chrome
2. Open DevTools → Network tab
3. Check "Preserve log" (so the log survives page redirects)
4. Clear the log, then click "Log in"
5. Enter credentials and submit
6. Watch the request waterfall — every redirect, every cookie, every token

**mitmproxy approach:**
```bash
# Terminal 1: Start mitmproxy
mitmproxy --mode regular --listen-port 8080

# On your phone:
# 1. Connect to same WiFi
# 2. Set HTTP proxy to <your-machine-ip>:8080
# 3. Visit mitm.it in the browser, install the CA certificate
# 4. Open the app, log in
# 5. Watch requests appear in mitmproxy
```

**APK decompilation approach:**
```bash
jadx -d output/ app.apk
# Search for the login/auth layer
grep -r "login\|signIn\|authenticate\|AuthService\|LoginRepository" output/sources/
# Then read the actual auth code
```

### 2.2 Document what you find

Write down the exact sequence of HTTP requests. For each request, note:

1. **Method and URL** — `POST https://sso.example.com/auth/token`
2. **Headers** — especially `Content-Type`, `Authorization`, `User-Agent`, `Cookie`, custom headers
3. **Request body** — form-encoded? JSON? What fields?
4. **Response status** — 200? 302 redirect?
5. **Response headers** — `Set-Cookie`, `Location` (for redirects)
6. **Response body** — What tokens/cookies come back?

Example notes (real, from our TrainerRoad work):

```
STEP 1: GET https://www.trainerroad.com/app/login
  Response: 200 OK
  Body: HTML form with hidden input name="__RequestVerificationToken" value="CfDJ8..."
  Cookies set: __RequestVerificationToken (different from form value)

STEP 2: POST https://www.trainerroad.com/app/login
  Content-Type: application/x-www-form-urlencoded
  Cookie: __RequestVerificationToken=<from step 1>
  Body: Username=...&Password=...&__RequestVerificationToken=<from HTML form>
  Response: 302 redirect
  Set-Cookie: SharedTrainerRoadAuth=<base64 blob>; expires=<30 days>

STEP 3: All subsequent API calls
  Cookie: SharedTrainerRoadAuth=<from step 2>
```

### 2.3 Identify the auth pattern

Once you have the sequence, classify it. Common patterns (ordered by complexity):

1. **Simple token** — POST credentials, get a token back, send it as `Authorization: Bearer <token>`
2. **OAuth 2.0 password grant** — POST to token endpoint with `grant_type=password`, client ID, credentials
3. **Proprietary OAuth with hardcoded credentials** — Same as above but client ID/secret extracted from app
4. **Cookie-based form login** — GET login page, extract CSRF token, POST form, extract cookie from response
5. **Cognito / Firebase / Auth0** — Managed auth service with its own protocol (look for `cognito`, `firebaseapp`, `auth0` in URLs)
6. **Multi-step SSO** — Multiple redirects, ticket exchanges, token swaps (like Garmin's 5-step SSO → OAuth1 → OAuth2)

### 2.4 Test the auth flow manually

Before writing any code, verify your understanding with curl:

```bash
# Example: OAuth 2.0 password grant
curl -X POST https://auth.example.com/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=MyApp&username=you@email.com&password=yourpass"

# Example: Cookie-based login
# Step 1: Get CSRF
curl -c cookies.txt https://www.example.com/login | grep csrf
# Step 2: Submit login
curl -b cookies.txt -c cookies.txt -X POST https://www.example.com/login \
  -d "username=you@email.com&password=yourpass&_csrf=TOKEN_FROM_STEP_1"
# Step 3: Test an API call with the cookie
curl -b cookies.txt https://www.example.com/api/v1/user/me
```

If the curl works, you understand the auth flow. If it doesn't, you're missing a step — go back to 2.1.

## Phase 3: Mapping the data endpoints

Now that you can authenticate, explore what data is available.

### 3.1 Systematically capture all API calls

**Browser approach:**
1. Log in to the web app (with DevTools Network tab open)
2. Slowly click through every page and feature
3. For each page, note what API calls fire
4. Pay attention to the URL patterns — services usually follow a consistent structure

**APK approach:**
```bash
# Find all Retrofit interface definitions (most Android apps use Retrofit)
grep -r "@GET\|@POST\|@PUT\|@DELETE\|@PATCH" output/sources/
# This gives you every API endpoint the app knows about
```

**mitmproxy approach:**
```bash
# Use the app comprehensively — open every screen, pull every refresh
# Then export all captured flows
mitmdump -r flows.mitm --set flow_detail=3 > all_requests.txt
# Filter to just the API domain
grep "api.example.com" all_requests.txt
```

### 3.2 Organize endpoints by category

Group endpoints into logical categories. For a health/fitness app, this usually looks like:

```
Auth:
  POST /auth/token              — login
  POST /auth/refresh            — refresh token

User:
  GET  /user/profile            — display name, settings
  GET  /user/devices            — connected devices

Activities:
  GET  /activities?start=&end=  — list activities in date range
  GET  /activity/{id}           — single activity detail
  GET  /activity/{id}/stream    — second-by-second data (HR, power, GPS)
  GET  /activity/{id}/laps      — lap splits

Daily metrics:
  GET  /daily/{date}/summary    — steps, calories, distance
  GET  /daily/{date}/hr         — heart rate time series
  GET  /daily/{date}/stress     — stress levels
  GET  /daily/{date}/sleep      — sleep stages and scores

Body:
  GET  /weight?start=&end=      — weight measurements
```

### 3.3 Document response shapes

For each endpoint you care about, save a sample response. This becomes the basis for your TypeScript types.

```json
// GET /activities?start=2024-01-01&end=2024-01-31
// Response:
[
  {
    "activityId": 12345678,
    "activityName": "Morning Run",
    "activityType": { "typeKey": "running", "typeId": 1 },
    "startTimeGMT": "2024-01-15 12:30:00",
    "duration": 3600.0,
    "distance": 10000.0,
    "averageHR": 145.0,
    "maxHR": 175,
    "calories": 650
  }
]
```

Pay close attention to:
- **Types** — Is `duration` an integer or float? Is it seconds or milliseconds?
- **Units** — Is `distance` in meters, km, or miles? Is `weight` in grams, kg, or lbs?
- **Nullability** — Which fields are optional? What does the API return when there's no data?
- **Date formats** — ISO 8601? Unix epoch? "YYYY-MM-DD HH:MM:SS" without timezone?
- **Pagination** — Offset/limit? Cursor? Page number? Are results capped?

### 3.4 Watch for hidden gems

The most valuable data is often in endpoints you wouldn't guess exist:

- **WHOOP:** `weightlifting-service` was never mentioned in their web app but returned exercise-level set/rep data
- **Garmin Connect:** `hrv-service`, `metrics-service/trainingreadiness`, `metrics-service/racepredictions` — none exposed via the official API
- **Fitbit (internal):** Intraday heart rate at 1-second resolution vs. 1-minute in the official API

When decompiling APKs, search for URL paths that don't appear in network captures — these might be features in development or only available on newer app versions.

## Phase 4: Building the client

### 4.1 Start with types

Translate your documented response shapes into TypeScript interfaces. Be precise about optionality and types.

```typescript
// types.ts
export interface ActivitySummary {
  activityId: number;
  activityName: string;
  activityType: { typeKey: string; typeId: number };
  startTimeGMT: string;          // "2024-01-15 12:30:00" — NOT an ISO string
  duration: number;               // seconds (float)
  distance?: number;              // meters (float, optional for non-GPS activities)
  averageHR?: number;
  maxHR?: number;
  calories?: number;
}
```

### 4.2 Build the auth + client class

Follow the package pattern from [reverse-engineering-apis.md](./reverse-engineering-apis.md#package-structure):

```typescript
// client.ts
export class ServiceClient {
  private accessToken: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.accessToken = accessToken;
    this.fetchFn = fetchFn;
  }

  // Static auth method
  static async signIn(
    email: string,
    password: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<AuthResult> {
    // Implement the auth flow you documented in Phase 2
  }

  // Instance methods for data endpoints
  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    const response = await this.fetchFn(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        // Include any required custom headers
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error (${response.status}): ${text}`);
    }
    return response.json() as Promise<T>;
  }

  async getActivities(start: string, end: string): Promise<ActivitySummary[]> {
    return this.get("/activities", { start, end });
  }
}
```

**Key design decisions:**
- **Always inject `fetchFn`** — makes testing trivial (pass a mock fetch), avoids `node-fetch` dependency issues
- **Static `signIn`, instance methods for data** — auth is a one-time operation, data fetching uses stored tokens
- **Type the responses** — the `get<T>` generic keeps everything type-safe
- **Throw on HTTP errors** — don't silently return null, let the caller decide how to handle failures

### 4.3 Write parsing functions

Separate raw API types from your normalized output types. This is where you handle unit conversions, date parsing, and field mapping.

```typescript
// parsing.ts
export function parseActivity(raw: ActivitySummary): ParsedActivity {
  // Garmin's "GMT" strings need explicit UTC parsing
  const gmtString = raw.startTimeGMT.replace(" ", "T") + "Z";
  const startedAt = new Date(gmtString);

  return {
    externalId: String(raw.activityId),
    activityType: mapSport(raw.activityType.typeKey),
    name: raw.activityName,
    startedAt,
    endedAt: new Date(startedAt.getTime() + raw.duration * 1000),
    distanceMeters: raw.distance,      // already in meters for this API
    averageHeartRate: raw.averageHR,
  };
}
```

### 4.4 Write tests for parsing

Test the parsing functions with real-ish data. Focus on:
- Unit conversions (grams → kg, cm → m, tenths-of-seconds → seconds)
- Date parsing edge cases (timezone handling, midnight crossings)
- Missing optional fields (undefined, null, 0)
- Sport type mapping (known types → normalized names, unknown → "other")

```typescript
it("converts weight from grams to kg", () => {
  const parsed = parseWeight({ weight: 82500, /* ... */ });
  expect(parsed.weightKg).toBe(82.5);
});

it("handles missing optional fields", () => {
  const parsed = parseActivity({ /* only required fields */ });
  expect(parsed.distanceMeters).toBeUndefined();
  expect(parsed.averageHeartRate).toBeUndefined();
});
```

You do NOT need to test the HTTP client with real API calls. The auth flow is inherently hard to unit test (it involves multiple HTTP round trips with cookies, redirects, HTML parsing). Test the pure logic — parsing, sport mapping, unit conversion — and manually verify the auth flow works with curl.

## Phase 5: Integration

### 5.1 Wire into the provider

Create `src/providers/<service>.ts` that imports from the package and implements the `Provider` interface:

```typescript
import { ServiceClient, parseActivity } from "service-client";

export class ServiceProvider implements Provider {
  readonly id = "service";
  readonly name = "Service Name";

  async sync(db: Database, since: Date): Promise<SyncResult> {
    const tokens = await loadTokens(db, this.id);
    const client = new ServiceClient(tokens.accessToken);
    const activities = await client.getActivities(since.toISOString(), new Date().toISOString());

    for (const raw of activities) {
      const parsed = parseActivity(raw);
      await db.insert(activity).values({ ... }).onConflictDoUpdate({ ... });
    }
  }
}
```

### 5.2 Handle token lifecycle

The provider is responsible for token storage, refresh, and re-authentication. The package client should be stateless.

```typescript
// Token refresh pattern
private async resolveTokens(db: Database): Promise<TokenSet> {
  const tokens = await loadTokens(db, this.id);
  if (!tokens) throw new Error("No tokens found — authorize first");
  if (tokens.expiresAt > new Date()) return tokens;     // still valid
  if (tokens.refreshToken) return this.refreshTokens(db, tokens);   // can refresh
  return this.reAuthenticate(db);   // must re-login (Eight Sleep, TrainerRoad)
}
```

### 5.3 Register and test

1. Add to `src/index.ts`: `registerProvider(new ServiceProvider())`
2. Add env vars to `.env` (via SOPS if credentials)
3. Run `pnpm test` to verify parsing tests pass
4. Run a manual sync to verify the full flow works end-to-end

## Appendix: Common pitfalls

### The API works in curl but not in code

- **Missing User-Agent** — Some APIs reject requests without a mobile User-Agent
- **Missing cookies** — Your fetch implementation might not persist cookies across redirects
- **Redirect following** — Use `redirect: "manual"` when you need to capture `Set-Cookie` headers from redirect responses
- **Content-Type** — Some APIs require `application/x-www-form-urlencoded` and reject `application/json` (or vice versa)

### The API suddenly stops working

- **Token expired** — Check `expires_in` and implement refresh
- **Rate limited** — Look for `429 Too Many Requests` or `Retry-After` headers. Add exponential backoff.
- **App update changed the API** — Download the latest APK and re-decompile. Endpoints move.
- **IP blocked** — Some services block IPs that make too many requests. Use delays between calls.
- **Certificate pinning added** — If proxy interception stops working, the app added pinning. Switch to APK decompilation.

### The response shape changed

Internal APIs have no stability guarantees. Defensive coding helps:

```typescript
// Good: handle missing fields gracefully
const score = data.sleepScores?.overall?.value;

// Bad: assume structure exists
const score = data.sleepScores.overall.value;  // crashes if sleepScores is null
```

Store the raw API response in a `raw` JSONB column so you can re-parse historical data when you discover new fields or fix parsing bugs.

### "I can't find the endpoint for X"

If the app shows data but you can't find the API call:
1. **GraphQL** — Some apps use a single `/graphql` endpoint for everything. Look for query strings in the request body.
2. **WebSocket** — Real-time data (live HR, GPS) might come over WebSocket, not REST.
3. **Bundled in another response** — The data might be nested inside a larger "dashboard" or "summary" response.
4. **Computed client-side** — Some values are calculated in the app from other data (e.g., training load from activity history). These won't have their own endpoint.
5. **Different API version** — The app might hit `/v2/` while you're looking at `/v1/`. Check the APK for version strings.
