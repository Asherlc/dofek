# @dofek/auth

Shared authentication types and schemas.

## Features

- **Identity Providers**: Definitions for supported OAuth providers (Google and Apple).
- **User Schema**: Zod-validated schema for the authenticated user object.
- **Provider Configuration**: Schema for tracking which identity and data providers are configured for a user.

## Implementation Details

### Supported Providers
Identity providers are limited to the `IDENTITY_PROVIDER_NAMES` array: `["google", "apple"]`.

### Data Schemas
- `AuthUserSchema`: Validates `id`, `name`, `email` (nullable), and an optional `isAdmin` flag.
- `ConfiguredProvidersSchema`: Validates the set of identity providers, data providers (arbitrary strings), and a `nativeApple` flag for iOS integrations.
