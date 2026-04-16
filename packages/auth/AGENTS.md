# Auth Agents

> [!IMPORTANT]
> Read the [README.md](./README.md) first for the canonical overview of this package.

## Core Mandates
- **Type Safety**: Use `AuthUser` and `ConfiguredProviders` types for all authentication-related state management in both web and mobile.
- **Validation**: Always use `AuthUserSchema.parse()` when receiving user data from the API or local storage.

## Implementation Notes
- **Identity Providers**: Adding a new OAuth provider requires updating `IDENTITY_PROVIDER_NAMES` in `src/auth.ts`.
- **Native Integration**: The `nativeApple` flag in `ConfiguredProviders` specifically tracks if Apple Health is active via the native iOS module.
