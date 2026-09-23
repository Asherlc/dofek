# Credential Encryption at Rest

<!-- cspell:ignore ciphertext -->

Dofek encrypts stored provider tokens and webhook secrets,
and dynamic MCP client secrets through
`src/security/credential-encryption.ts`.

The implementation uses the AWS Encryption SDK raw AES keyring with
AES-256-GCM and a required encryption context. AWS documents encryption
contexts as authenticated, non-secret key-value metadata:
<https://docs.aws.amazon.com/encryption-sdk/latest/developer-guide/concepts.html#encryption-context>.

## Required Configuration

`CREDENTIAL_ENCRYPTION_KEY_BASE64` must decode to exactly 32 bytes. Application
paths that encrypt credentials fail immediately if the key is missing or the
decoded length is wrong.

Optional identifiers default to:

```text
CREDENTIAL_ENCRYPTION_KEY_NAMESPACE=dofek
CREDENTIAL_ENCRYPTION_KEY_NAME=provider-credentials
```

Operators provision the values with the Infisical
[`secrets set` command](https://infisical.com/docs/cli/commands/secrets):

```bash
openssl rand -base64 32
infisical secrets set --env=prod \
  CREDENTIAL_ENCRYPTION_KEY_BASE64='<generated-value>' \
  CREDENTIAL_ENCRYPTION_KEY_NAMESPACE='dofek' \
  CREDENTIAL_ENCRYPTION_KEY_NAME='provider-credentials'
```

Never print or commit the generated key. The same master key also derives
secret-keyed provider-account namespaces with HKDF-SHA256, following
[RFC 5869](https://www.rfc-editor.org/rfc/rfc5869). Do not change the key,
namespace, or name without a migration that decrypts every existing value with
the old keyring and re-encrypts it with the new one. Changing keyring
configuration alone makes existing ciphertext unreadable. Rotating the master
key additionally requires rederiving persisted `food_entry.source_account_key`
and dependent Ziva `external_id` values; otherwise later syncs would use a new
source identity.

## Storage Contract

Encrypted strings use the `enc:v1:` prefix. Encryption authenticates:

- purpose (`provider-credentials`);
- table name;
- column name;
- row or domain scope ID.

Copying ciphertext to a different table, column, or scope causes decryption to
fail with a context mismatch. Existing plaintext values remain readable for
migration compatibility, but repository writes encrypt them.

Only repository and data-access code may call `encryptCredentialValue()` or
`decryptCredentialValue()`. Routes, services, and provider sync code consume
plaintext domain values returned by repositories; they must not decrypt
database values directly.

Repository code may call `deriveCredentialIdentifier()` when a stable,
context-bound account namespace must be persisted without exposing the source
account identifier. The derivation binds the storage table, column, and scope;
provider logic receives only the opaque result.

## Validation

Run:

```bash
pnpm exec vitest run src/security/credential-encryption.test.ts --project unit
```

Tests cover round trips, encryption-context binding, plaintext compatibility,
stable identifier derivation, missing configuration, and invalid key length.
