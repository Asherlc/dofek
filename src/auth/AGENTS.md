# Auth Agent Guide

> **Read the [README.md](./README.md) first** for the core architecture and features.

## Agent-Specific Information

### Development Rules
- **Security First**: Never log `access_token` or `refresh_token`.
- **Redirect URI Safety**: Use `isLocalOrPrivateHost` to decide between `http` and `https` for local redirect URIs.
- **PKCE by Default**: Prefer PKCE for all new OAuth integrations where supported by the provider.
- **RFC 7009**: Implement token revocation if the provider supports it.

### Testing Strategy
- **Unit Tests**: `oauth.test.ts` for verifying URL construction and token parsing logic.
- **Mocking**: Use `vitest` to mock `globalThis.fetch` during token exchange tests.
- **Callback Server Tests**: `callback-server.test.ts` for verifying that the temporary server correctly extracts the `code` parameter.

### Adding a New Auth Flow
1. Check if the provider uses standard OAuth 2.0.
2. If yes, use the existing helpers in `oauth.ts`.
3. If not (e.g., OAuth 1.0), implement the custom flow in the provider file and define an interface in `src/providers/types.ts`.
