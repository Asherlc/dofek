# @dofek/auth

Shared authentication types and schemas.

## Features

- **Identity Providers**: Definitions for supported OAuth providers (Google and Apple).
- **User Schema**: Zod-validated schema for the authenticated user object.
- **Provider Configuration**: Schema for tracking which identity and data providers are configured for a user.
- **Credential Validation**: Shared email guidance and the server's canonical 8–128-character password policy for registration clients.
- **Developer Clients**: Owner-management request and response schemas, exact HTTPS redirect canonicalization, and the transport-neutral REST client used by Dofek web and mobile.

## Implementation Details

### Supported Providers
Identity providers are limited to the `IDENTITY_PROVIDER_NAMES` array: `["google", "apple"]`.

### Data Schemas
- `AuthUserSchema`: Validates `id`, `name`, `email` (nullable), and an optional `isAdmin` flag.
- `ConfiguredProvidersSchema`: Validates the set of identity providers, data providers (arbitrary strings), and a `nativeApple` flag for iOS integrations.

### Developer Client Boundary

`@dofek/auth/developer-clients` is the shared executable contract for Dofek's web and mobile developer-integration screens. List and detail responses cannot contain a client secret. Create and rotate responses return the secret once, and consumers must keep it out of persistent storage and query caches.

Registered callbacks are canonical HTTPS URIs without credentials or fragments. The external authorization flow additionally requires the incoming redirect string to exactly match a registered value, following the redirect-validation guidance in [OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.1). External clients use S256 Proof Key for Code Exchange as defined by [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html).
