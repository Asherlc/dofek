import {
  buildClient,
  CommitmentPolicy,
  RawAesKeyringNode,
  RawAesWrappingSuiteIdentifier,
} from "@aws-crypto/client-node";

const encryptedValuePrefix = "enc:v1:";
const credentialPurpose = "provider-credentials";
const encryptionKeyEnvName = "CREDENTIAL_ENCRYPTION_KEY_BASE64";

const { encrypt, decrypt } = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT);

export interface CredentialEncryptionContext {
  tableName: string;
  columnName: string;
  scopeId: string;
}

export interface CredentialEncryptionProvider {
  providerId: string;
  encryptValue(value: string, context: CredentialEncryptionContext): Promise<string>;
  decryptValue(value: string, context: CredentialEncryptionContext): Promise<string>;
}

interface RawAesProviderConfig {
  keyName: string;
  keyNamespace: string;
  unencryptedMasterKey: Uint8Array;
}

class AwsEncryptionSdkCredentialEncryptionProvider implements CredentialEncryptionProvider {
  readonly providerId = "aws-encryption-sdk/raw-aes-keyring";
  readonly #keyring: RawAesKeyringNode;

  constructor(config: RawAesProviderConfig) {
    this.#keyring = new RawAesKeyringNode({
      keyName: config.keyName,
      keyNamespace: config.keyNamespace,
      unencryptedMasterKey: config.unencryptedMasterKey,
      wrappingSuite: RawAesWrappingSuiteIdentifier.AES256_GCM_IV12_TAG16_NO_PADDING,
    });
  }

  async encryptValue(value: string, context: CredentialEncryptionContext): Promise<string> {
    if (isEncryptedCredentialValue(value)) {
      return value;
    }

    const { result } = await encrypt(this.#keyring, value, {
      encryptionContext: buildEncryptionContext(context),
    });

    return `${encryptedValuePrefix}${Buffer.from(result).toString("base64")}`;
  }

  async decryptValue(value: string, context: CredentialEncryptionContext): Promise<string> {
    if (!isEncryptedCredentialValue(value)) {
      return value;
    }

    const encryptedBytes = Buffer.from(value.slice(encryptedValuePrefix.length), "base64");
    const { plaintext, messageHeader } = await decrypt(this.#keyring, encryptedBytes);
    verifyEncryptionContext(messageHeader.encryptionContext, context);
    return Buffer.from(plaintext).toString("utf-8");
  }
}

function buildEncryptionContext(
  context: CredentialEncryptionContext,
): Readonly<Record<string, string>> {
  return {
    purpose: credentialPurpose,
    table_name: context.tableName,
    column_name: context.columnName,
    scope_id: context.scopeId,
  };
}

function verifyEncryptionContext(
  actualContext: Readonly<Record<string, string>>,
  expectedContext: CredentialEncryptionContext,
): void {
  const expectedValues = buildEncryptionContext(expectedContext);

  for (const [key, expectedValue] of Object.entries(expectedValues)) {
    const actualValue = actualContext[key];
    if (actualValue !== expectedValue) {
      throw new Error(
        `Credential encryption context mismatch for ${expectedContext.tableName}.${expectedContext.columnName} (key=${key}).`,
      );
    }
  }
}

function buildProviderFromEnvironment(): CredentialEncryptionProvider {
  const encodedKey = process.env[encryptionKeyEnvName];
  if (!encodedKey) {
    throw new Error(`${encryptionKeyEnvName} is required for credential encryption`);
  }

  const decodedKey = Buffer.from(encodedKey, "base64");
  const unencryptedMasterKey = Uint8Array.from(decodedKey);
  if (unencryptedMasterKey.byteLength !== 32) {
    throw new Error(`${encryptionKeyEnvName} must decode to exactly 32 bytes`);
  }

  return new AwsEncryptionSdkCredentialEncryptionProvider({
    keyName: process.env.CREDENTIAL_ENCRYPTION_KEY_NAME ?? "provider-credentials",
    keyNamespace: process.env.CREDENTIAL_ENCRYPTION_KEY_NAMESPACE ?? "dofek",
    unencryptedMasterKey,
  });
}

export function isEncryptedCredentialValue(value: string): boolean {
  return value.startsWith(encryptedValuePrefix);
}

export async function encryptCredentialValue(
  value: string,
  context: CredentialEncryptionContext,
): Promise<string> {
  const provider = buildProviderFromEnvironment();
  return provider.encryptValue(value, context);
}

export async function decryptCredentialValue(
  value: string,
  context: CredentialEncryptionContext,
): Promise<string> {
  if (!isEncryptedCredentialValue(value)) {
    return value;
  }

  const provider = buildProviderFromEnvironment();
  return provider.decryptValue(value, context);
}
