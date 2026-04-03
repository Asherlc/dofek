# Peloton Provider

## Authentication

Peloton migrated from an internal `/auth/login` endpoint to Auth0 in late 2025. The old endpoint returns `403 Access forbidden. Endpoint no longer accepting requests.`

### Auth0 OAuth2 with PKCE

- **Auth domain**: `auth.onepeloton.com`
- **Client ID**: `WVoJxVDdPoFx4RNewvvg6ch2mZ7bwnsM` (public client, from peloton-to-garmin)
- **Redirect URI**: `https://members.onepeloton.com/callback` (Peloton's own — cannot use localhost)
- **Scopes**: `offline_access openid peloton-api.members:default`
- **Audience**: `https://api.onepeloton.com/`
- **Token URL**: `https://auth.onepeloton.com/oauth/token`

### Automated Login Flow

Since we can't use a browser redirect (the redirect URI is hardcoded to Peloton's domain), we drive Auth0's Universal Login Page programmatically:

1. **GET `/authorize`** with PKCE code_challenge → follow redirects, collect cookies
2. **Parse login page** — Auth0 embeds config in `window.injectedConfig` as a base64-encoded JSON blob containing `state`, `_csrf`, and `nonce`
3. **POST credentials** to `/usernamepassword/login` with the Auth0-provided state/csrf/nonce
4. **Parse hidden form** — response is HTML with `<form>` containing `wa`, `wresult` (JWT), `wctx` fields
5. **HTML-decode field values** — Auth0 uses `&#34;` entities in the `wctx` JSON, must decode before submission
6. **Submit form** to `/login/callback` → follow redirect chain → capture `?code=` from final Location header
7. **Exchange code** for tokens via `/oauth/token` with PKCE code_verifier

### Multi-Domain Cookie Handling

The redirect chain crosses 3 domains:
- `auth.onepeloton.com` — Auth0 tenant
- `auth-orca.onepeloton.com` — Peloton SSO layer
- `members.onepeloton.com` — Final callback

Cookies must be scoped per domain. Node's `fetch` doesn't persist cookies across redirects, so we use a custom `CookieJar` that tracks cookies by hostname and only sends them to matching domains.

### PerimeterX Bot Detection

The login page loads a PerimeterX script (`client.px-cloud.net`). As of March 2026, PX does not block the automated login flow — the cookie-based auth works without running the PX JavaScript.

## API

- **Base URL**: `https://api.onepeloton.com`
- **Auth**: `Authorization: Bearer <access_token>` + `peloton-platform: web` header
- **User ID**: `GET /api/me` → `{ id: "..." }`
- **Workouts**: `GET /api/user/{userId}/workouts?page=0&limit=20&sort_by=-created_at&joins=ride`
- **Performance Graph**: `GET /api/workout/{workoutId}/performance_graph?every_n=5`

### Workout List Response

```json
{
  "data": [{ "id": "...", "status": "COMPLETE", "fitness_discipline": "cycling", ... }],
  "total": 100, "count": 20, "page": 0, "show_next": true
}
```

Only `status: "COMPLETE"` workouts are synced. Pagination uses `show_next` flag.

### Performance Graph

Returns time-series metrics (heart_rate, output/power, cadence, speed) plus summaries (calories, distance). Distance is in **miles** — we convert to meters (* 1609.344).

### Fitness Discipline Mapping

| Peloton | Our Type |
|---------|----------|
| cycling | cycling |
| running | running |
| walking | walking |
| rowing, caesar | rowing |
| strength | strength |
| yoga | yoga |
| bike_bootcamp, tread_bootcamp | bootcamp |
| outdoor | running |

## Data Stored

- **activity**: Activity type, duration, distance, calories, HR, power, cadence, speed, plus JSONB `raw` with instructor, class title, difficulty rating, leaderboard rank
- **metric_stream**: Time-series rows at 5-second intervals for HR, power, cadence, speed

## Credentials

Credentials are entered via the web UI modal (automated Auth0 login). No environment variables required.
