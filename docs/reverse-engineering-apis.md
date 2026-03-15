# Reverse Engineering Fitness APIs

A practical guide for reverse engineering internal/private APIs from fitness and health platforms that don't offer public developer APIs.

## When to reverse engineer

Use this approach when a platform:
- Has no public API or developer program
- Has a partner-only API with no realistic path to access
- Has a deprecated or limited public API that doesn't expose the data you need

We've successfully reverse engineered: **WHOOP**, **Eight Sleep**, **Zwift**, **TrainerRoad**, **VeloHero**, and **Garmin Connect** (internal API).

## Discovery methods

### 1. Mobile app decompilation (Android APK)

The most powerful method. Android APKs are essentially ZIP files containing Java bytecode that can be decompiled back to readable source. This is how we discovered WHOOP's weightlifting endpoints, Eight Sleep's hardcoded credentials, and confirmed Garmin Connect's SSO flow.

**Tools:**
- [jadx](https://github.com/skylot/jadx) — decompile APK to Java source (best for reading code)
- [jadx-gui](https://github.com/skylot/jadx) — GUI version with search, cross-references, and code navigation
- [apktool](https://github.com/iBotPeaches/Apktool) — extract resources, smali code, AndroidManifest.xml
- [dex2jar](https://github.com/pxb1988/dex2jar) — convert DEX to JAR for use with Java decompilers
- APK download: [APKMirror](https://www.apkmirror.com/), [APKPure](https://apkpure.com/), [APKCombo](https://apkcombo.com/)

**Step-by-step APK decompilation:**

```bash
# 1. Install jadx (macOS)
brew install jadx

# 2. Download APK from APKMirror/APKPure
# (search for the app, download the latest version)

# 3. Decompile to Java source
jadx -d output_dir/ app.apk

# 4. Search for API endpoints
grep -r "https://api\." output_dir/
grep -r "base_url\|baseUrl\|BASE_URL" output_dir/
grep -r "\.com/v[0-9]" output_dir/

# 5. Search for auth credentials
grep -r "client_id\|clientId\|CLIENT_ID" output_dir/
grep -r "client_secret\|clientSecret" output_dir/
grep -r "api_key\|apiKey\|API_KEY" output_dir/

# 6. Search for auth endpoints
grep -r "oauth\|cognito\|auth.*token\|login\|signin" output_dir/

# 7. Search for data models (Kotlin data classes / Java POJOs)
grep -r "data class\|@SerializedName\|@JsonProperty" output_dir/

# 8. Use jadx-gui for interactive exploration
jadx-gui app.apk
# Then use Edit > Search (Ctrl+Shift+F) for text/code/class search
```

**What to look for:**
- **API base URLs** — search for `https://api.` or `base_url` in decompiled source
- **Client IDs and secrets** — search for `client_id`, `client_secret`, `api_key`
- **Auth endpoints** — search for `oauth`, `token`, `auth`, `login`, `cognito`
- **Hidden endpoints** — services not exposed in the web app (e.g., WHOOP's weightlifting service was only discoverable via APK)
- **Request/response models** — Java/Kotlin data classes show exact field names and types
- **Retrofit/OkHttp interceptors** — often contain auth header injection, base URLs, and custom headers
- **BuildConfig constants** — compile-time config like API keys and environment URLs
- **Proguard/R8 mappings** — if the app is obfuscated, look for `mapping.txt` or string constants that aren't obfuscated

**Dealing with obfuscation:**
- Most health/fitness apps use light obfuscation (ProGuard) — class names are mangled but strings (URLs, keys) remain readable
- Search for string literals first: API URLs, "Bearer", "Authorization", "Content-Type"
- Follow string references back to their containing classes to understand the API layer
- Retrofit interface annotations (`@GET`, `@POST`, `@Path`, `@Query`) are usually preserved
- Kotlin data classes with `@Serializable` or `@JsonProperty` annotations often survive obfuscation

**Dealing with app bundles (AAB/split APKs):**
- Modern apps use Android App Bundles — APKMirror provides these as `.apks` (XAPK) bundles
- Use [SAI](https://github.com/nicejjin/SAI) or `bundletool` to merge split APKs
- Or just download the universal APK variant when available

**Example — Eight Sleep:**
```
# Found in decompiled APK:
CLIENT_ID = "0894c7f33bb94800a03f1f4df13a4f38"
CLIENT_SECRET = "f0954a3ed5763ba3d06834c73731a32f15f168f47d4f164751275def86db0c76"
AUTH_BASE = "https://auth-api.8slp.net/v1"
API_BASE = "https://client-api.8slp.net/v1"
```

**Example — WHOOP (discovered weightlifting endpoints):**
```
# Found in decompiled APK that web app doesn't expose:
/weightlifting-service/v2/weightlifting-workout/{activityId}
# Returns exercise-level data: sets, reps, weight per exercise
```

**Priority targets for APK decompilation:**
- **Fitbit** — official API deprecated, internal API has much richer data (intraday HR, stress, SpO2 time series)
- **Polar** — official API lacks HRV, recovery, and training load
- **Samsung Health** — no public API, all data is in the app
- **Oura** — official API is limited, app shows detailed readiness/sleep breakdown

### 2. Browser network inspection

For platforms with web apps, Chrome DevTools Network tab reveals everything.

**Steps:**
1. Open DevTools → Network tab
2. Log in and use the app normally
3. Filter by `XHR/Fetch` to see API calls
4. Inspect request headers (auth tokens, API keys, CSRF tokens)
5. Inspect response bodies (data format, field names, pagination)

**What to capture:**
- Auth flow: how login works (form POST? OAuth? Cognito?)
- Cookie names and values
- Custom headers (API keys, CSRF tokens, subscription keys)
- Pagination patterns (offset, cursor, page number)
- Date format expectations (ISO, UNIX seconds, YYYY-MM-DD)

**Example — TrainerRoad:**
```
# Login flow discovered via browser:
1. GET /app/login → extract __RequestVerificationToken from HTML
2. POST /app/login (form-encoded with CSRF token)
3. Response sets SharedTrainerRoadAuth cookie
4. All API calls use Cookie: SharedTrainerRoadAuth=<value>
```

### 3. Existing open-source clients

Often someone has already done the hard work. Search GitHub for unofficial clients.

**Search queries:**
- `"<service> api" unofficial client`
- `"<service>" reverse engineer`
- `<service>-api-wrapper`
- Check [tapiriik](https://github.com/cpfair/tapiriik) (fitness aggregator with many service integrations)

**Examples we leveraged:**
- **Zwift:** [rally25rs/zwift-api-wrapper](https://github.com/rally25rs/zwift-api-wrapper) documented the Keycloak auth and API endpoints
- **VeloHero:** tapiriik's [velohero.py](https://github.com/cpfair/tapiriik/blob/master/tapiriik/services/VeloHero/velohero.py) documented the SSO flow

### 4. Proxy interception (mobile traffic)

For mobile-only apps where you can't just open DevTools.

**Tools:**
- [mitmproxy](https://mitmproxy.org/) — intercept HTTPS traffic
- [Charles Proxy](https://www.charlesproxy.com/)
- [Proxyman](https://proxyman.io/) (macOS)

**Setup:**
1. Install proxy on your machine
2. Install proxy's CA certificate on your phone
3. Set phone's WiFi proxy to your machine's IP
4. Use the app and watch requests flow through

**Note:** Many apps use certificate pinning which blocks proxy inspection. Android APK decompilation is often easier.

## Authentication patterns

### Pattern 1: OAuth 2.0 password grant (Zwift)

The simplest reverse-engineered auth. Post credentials directly, get tokens back.

```typescript
// Zwift uses Keycloak with a publicly known client ID
const response = await fetch(AUTH_URL, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: "Zwift Game Client",  // embedded in game client
    grant_type: "password",
    username,
    password,
  }),
});
// Returns: access_token, refresh_token, expires_in
```

**Refresh:** Same endpoint with `grant_type: refresh_token`.

### Pattern 2: Proprietary OAuth with hardcoded credentials (Eight Sleep)

Like standard OAuth but with client credentials extracted from the mobile app.

```typescript
const response = await fetch(`${AUTH_BASE}/tokens`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_id: EXTRACTED_CLIENT_ID,
    client_secret: EXTRACTED_CLIENT_SECRET,
    grant_type: "password",
    username: email,
    password,
  }),
});
// Returns: access_token, expires_in, userId
// No refresh tokens — must re-authenticate when expired
```

### Pattern 3: Cognito-based auth (WHOOP)

AWS Cognito proxied through the service's own endpoint.

```typescript
const response = await fetch(COGNITO_ENDPOINT, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-amz-json-1.1",
    "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
  },
  body: JSON.stringify({
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: COGNITO_CLIENT_ID,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }),
});
// May return MFA challenge that needs RespondToAuthChallenge
```

### Pattern 4: Cookie-based form login (TrainerRoad)

Classic web form login with CSRF protection.

```typescript
// 1. Get CSRF token
const loginPage = await fetch("/app/login");
const html = await loginPage.text();
const csrfToken = html.match(/name="__RequestVerificationToken"\s+value="([^"]+)"/)?.[1];

// 2. Submit login form
const loginResponse = await fetch("/app/login", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    Username: username,
    Password: password,
    __RequestVerificationToken: csrfToken,
  }),
  redirect: "manual",  // don't follow redirects — we need the Set-Cookie header
});

// 3. Extract auth cookie
const cookies = loginResponse.headers.getSetCookie();
const authCookie = cookies.find(c => c.startsWith("SharedTrainerRoadAuth="));
```

### Pattern 5: Session token via SSO endpoint (VeloHero)

Simple form POST that returns a session token.

```typescript
const response = await fetch(`${BASE_URL}/sso`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ user: email, pass: password, view: "json" }),
});
const data = await response.json();
// Use data.session as cookie: VeloHero_session=<token>
```

### Pattern 6: Multi-step SSO with OAuth1→OAuth2 exchange (Garmin Connect)

The most complex auth flow we've encountered. Garmin's SSO involves CSRF tokens, session cookies, an OAuth1 ticket exchange, and a final OAuth2 token swap.

```typescript
// Step 1: GET /sso/embed — initialize session cookies
// Step 2: GET /sso/signin — extract CSRF token from HTML
const csrfToken = html.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];

// Step 3: POST /sso/signin — submit credentials
const loginResponse = await fetch(`${SSO_BASE}/signin?${params}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: sessionCookies,
    Referer: `${SSO_BASE}/signin`,
  },
  body: new URLSearchParams({
    username, password, embed: "true", _csrf: csrfToken,
  }),
  redirect: "manual",
});
// Parse response HTML for: embed?ticket=([^"]+)"

// Step 4: Exchange ticket for OAuth1 token
const oauth1Response = await fetch(
  `${OAUTH_BASE}/preauthorized?ticket=${ticket}&login-url=...&accepts-mfa-tokens=true`
);
// Returns URL-encoded: oauth_token, oauth_token_secret, mfa_token

// Step 5: Exchange OAuth1 for OAuth2
const oauth2Response = await fetch(`${OAUTH_BASE}/exchange/user/2.0`, {
  method: "POST",
  body: new URLSearchParams({ mfa_token: mfaToken }),
});
// Returns JSON: access_token, refresh_token, expires_in
```

**Key details:** Cookie jar must persist across all 5 steps. User-Agent must be `com.garmin.android.apps.connectmobile`. MFA is supported (SMS + TOTP).

## Common tricks and gotchas

### JWT decoding for user IDs

Many services embed the user/athlete ID in the JWT access token payload. Decode it instead of making a separate API call:

```typescript
const payload = JSON.parse(
  Buffer.from(accessToken.split(".")[1], "base64").toString()
);
const userId = payload.sub;  // or payload.userId, payload.athlete_id, etc.
```

### Unit conversion landmines

APIs often use unexpected units:
- **Zwift:** speed in cm/s, altitude in cm, distance in cm, weight in grams
- **Eight Sleep:** duration in seconds, time series as `[ISO_string, value]` tuples
- **TrainerRoad:** `Duration` is in seconds but `workoutData.seconds` is actually milliseconds
- **Concept2:** time in tenths of a second
- **WHOOP:** sleep times in Postgres range format `[start,end)`
- **Garmin Connect:** weight in grams, body battery as charge/drain integers, HR time series as `[timestamp, value|null]` tuples

### Custom User-Agent headers

Some APIs check User-Agent and reject non-mobile clients:
```typescript
headers: {
  "User-Agent": "okhttp/4.9.3",  // Eight Sleep expects Android HTTP client
}
```

### Date windowing

Some APIs limit how much data you can request at once:
- **WHOOP:** cycles endpoint has a 200-day window limit — loop in chunks
- **VeloHero/TrainerRoad:** use date range params to avoid huge responses

### Redirect handling

Cookie-based auth often redirects on login. Use `redirect: "manual"` to capture the Set-Cookie header before the redirect happens.

### Re-authentication strategy

For services without refresh tokens (Eight Sleep, TrainerRoad, VeloHero):
1. Store credentials as environment variables (`SERVICE_USERNAME`, `SERVICE_PASSWORD`)
2. Check token/cookie expiry before each sync
3. Re-authenticate automatically if expired
4. Save new tokens to database

## Package structure

Each reverse-engineered API gets its own standalone package under `packages/`. This keeps the client code reusable, testable, and decoupled from our sync framework.

```
packages/
  <service-name>/
    package.json          # name, version, exports, zero runtime deps
    tsconfig.json         # ES2022, strict, nodenext
    src/
      client.ts           # API client class (signIn, getActivities, etc.)
      types.ts            # TypeScript interfaces matching API responses
      sports.ts           # Sport ID mapping (if applicable)
      index.ts            # Re-exports public API
```

**Key design principles:**
- **Zero runtime dependencies** — only TypeScript and Vitest as dev deps
- **Inject fetch** — accept `fetchFn` parameter for testability
- **Static sign-in** — `Client.signIn(email, password)` returns auth tokens
- **Instance methods** — `client.getActivities()` uses stored tokens
- **Export types** — all response interfaces exported for consumers
- **No database code** — the package is pure API client, provider wraps it

The provider file (`src/providers/<service>.ts`) then imports from the package and handles database operations, token storage, and sync orchestration.

## Ethical considerations

- Only access your own data with your own credentials
- Don't abuse rate limits — add delays between requests if needed
- Don't redistribute extracted client credentials publicly
- Be prepared for APIs to change without notice
- Consider reaching out to companies for official API access first
- Respect ToS — some services explicitly prohibit reverse engineering

## Adding a new reverse-engineered provider

See [reverse-engineering-walkthrough.md](./reverse-engineering-walkthrough.md) for a complete end-to-end guide. The short version:

1. **Research** — Try all discovery methods above. Document findings in `docs/<service>.md`
2. **Create package** — Set up `packages/<service>/` with client, types, sports mapping
3. **Write tests** — Test pure parsing functions and sport mapping
4. **Create provider** — Wire the package into `src/providers/<service>.ts`
5. **Register** — Add to `src/index.ts`
6. **Document** — Update `docs/<service>.md` with endpoints, auth flow, data available
