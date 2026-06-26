# Zoho Desk (Support / Contact form)

The in-app **Help & Support** form (web `/support`, mobile Support screen) files
tickets into [Zoho Desk](https://www.zoho.com/desk/) via the server. There is no
end-user OAuth flow — the server talks to Zoho machine-to-machine using a
long-lived refresh token.

## Architecture

```
SupportPanel (web + mobile)
  -> trpc support.createTicket            packages/server/src/routers/support.ts
    -> ZohoDeskClient.createTicket()      packages/server/src/lib/zoho-desk.ts
      -> POST https://desk.zoho.com/api/v1/tickets
```

`ZohoDeskClient`:

- Reads config from env via `zohoDeskConfigFromEnv()` (fails loudly on missing keys).
- Caches a short-lived (1h) access token in memory, refreshing slightly early.
- Mints access tokens with `grant_type=refresh_token` against the data center's
  `accounts.*` domain, then creates tickets against the `desk.*` domain.

The router pulls the contact email/name from the user's profile, allows an
optional reply-to override from the form, reports failures to Sentry, and returns
the created ticket number.

## Environment variables (all in Infisical, `prod`)

| Variable | Notes |
| --- | --- |
| `ZOHO_DESK_CLIENT_ID` | OAuth client ID from the Zoho API Console. |
| `ZOHO_DESK_CLIENT_SECRET` | OAuth client secret. |
| `ZOHO_DESK_REFRESH_TOKEN` | Long-lived refresh token (see below). |
| `ZOHO_DESK_ORG_ID` | Zoho Desk org ID (`929149487`). |
| `ZOHO_DESK_DEPARTMENT_ID` | Department tickets are filed under. |
| `ZOHO_DESK_DATA_CENTER` | One of `us`, `eu`, `in`, `au`, `jp`. Defaults to `us`. |

## OAuth setup (Self Client)

Zoho's server-to-server pattern: a one-time `authorization_code` exchange yields a
**permanent** refresh token (it does not auto-expire; it is only invalidated on
manual revoke or when the per-client refresh-token limit is exceeded).

1. In the [Zoho API Console](https://api-console.zoho.com/), create a **Self
   Client**. Copy the Client ID and Client Secret.
2. On the **Generate Code** tab, request scope
   `Desk.tickets.CREATE,Desk.contacts.CREATE` with a short duration. This
   produces a grant code (single-use, ~10 min).
3. Exchange the grant code for a refresh token:

   ```bash
   curl -X POST 'https://accounts.zoho.com/oauth/v2/token' \
     -d 'grant_type=authorization_code' \
     -d 'client_id=YOUR_CLIENT_ID' \
     -d 'client_secret=YOUR_CLIENT_SECRET' \
     -d 'code=THE_GRANT_CODE'
   ```

   Store the returned `refresh_token` as `ZOHO_DESK_REFRESH_TOKEN`.

> The Self Client is bound to the Zoho user who created it. For an account-agnostic
> production setup, use a **Server-based Application** client with a dedicated
> service account instead (functionally identical after the initial OAuth flow).
