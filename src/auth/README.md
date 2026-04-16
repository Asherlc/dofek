# Authentication

This directory contains OAuth 2.0 implementation and identity management.

## Core Features

- **OAuth 2.0 Client**: Implementation of the OAuth 2.0 redirect flow with PKCE support in `oauth.ts`.
- **Identity Extraction**: Capability to extract user profiles (name, email) from providers (e.g., Strava, Google).
- **Callback Server**: A temporary HTTP/HTTPS server (`callback-server.ts`) for capturing authorization codes during CLI setup.
- **PKCE**: Automatic generation of code verifiers and challenges for public clients.
- **Dynamic Redirects**: Logic to resolve the correct `redirect_uri` based on the environment (localhost vs production).

## Implementation Details

- **Token Management**: Functions for exchanging codes for tokens, refreshing expired tokens, and revoking tokens.
- **PKCE Support**: Mandatory for public clients, optional for others. Uses SHA-256 for code challenges.
- **HTTPS Callback**: Supports self-signed certificates for local HTTPS development.
- **OAuth 1.0**: Limited support for OAuth 1.0 (FatSecret) via the `OAuth1Flow` interface in providers.

## Key Files

- `oauth.ts`: Main OAuth 2.0 implementation (authorize, exchange, refresh, revoke).
- `callback-server.ts`: Local server for OAuth flow completion.
- `resolve-tokens.ts`: High-level utility to resolve tokens for a given provider and user.
- `redirect-uri.ts`: Environment-aware redirect URI calculation.
