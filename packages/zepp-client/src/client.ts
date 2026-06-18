import { createCipheriv } from "node:crypto";
import { z } from "zod";
import type { ZeppSignInResult } from "./types.ts";

export const ZEPP_REGISTRATION_REDIRECT_URI =
  "https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html";
export const ZEPP_ACCOUNT_LOGIN_URL = "https://account.huami.com/v2/client/login";
export const ZEPP_ACCOUNT_ZEPP_LOGIN_URL = "https://account.zepp.com/v2/client/login";
export const ZEPP_ENCRYPTED_REGISTRATION_URL = "https://api-user.zepp.com/v2/registrations/tokens";
export const ZEPP_APP_NAME = "com.xiaomi.hm.health";

const ZEPP_AES_KEY = "xeNtBVqzDc6tuNTh";
const ZEPP_AES_IV = "MAAAYAAAAAAAAABg";
const ZEPP_APP_VERSION = "6.14.0";

const zeppTokenInfoSchema = z.object({
  app_token: z.string(),
  user_id: z.union([z.string(), z.number()]).transform(String),
  login_token: z.string().optional(),
});

const zeppLoginResponseSchema = z
  .object({
    token_info: zeppTokenInfoSchema.optional(),
    result: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

const zeppRegistrationJsonSchema = z
  .object({
    access: z.string().optional(),
    country_code: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

interface ZeppAccessCredentials {
  accessCode: string;
  countryCode: string;
  loginUrl: string;
  thirdName: string;
  source?: string;
  dn: string;
}

function registrationUrl(email: string): string {
  return `https://api-user.huami.com/registrations/${encodeURIComponent(email)}/tokens`;
}

function parseRedirectCredentials(
  location: string,
  baseUrl: string,
): Pick<ZeppAccessCredentials, "accessCode" | "countryCode"> {
  const redirectUrl = new URL(location, baseUrl);
  const accessCode = redirectUrl.searchParams.get("access");
  const countryCode = redirectUrl.searchParams.get("country_code");
  if (!accessCode || !countryCode) {
    throw new Error("Amazfit/Zepp login failed: invalid email or password");
  }
  return { accessCode, countryCode };
}

function encryptZeppRegistrationBody(body: URLSearchParams): Uint8Array<ArrayBuffer> {
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(ZEPP_AES_KEY), Buffer.from(ZEPP_AES_IV));
  const encrypted = Buffer.concat([cipher.update(body.toString(), "utf8"), cipher.final()]);
  return new Uint8Array(encrypted);
}

function zeppClientHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "User-Agent": `MiFit${ZEPP_APP_VERSION} (android_phone; Android 15; Density/2.75)`,
    app_name: ZEPP_APP_NAME,
    appname: ZEPP_APP_NAME,
    appplatform: "android_phone",
    "hm-privacy-ceip": "false",
    "x-hm-ekv": "1",
  };
}

function isRetryableLegacyRegistrationStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

function invalidCredentialsError(): Error {
  return new Error("Amazfit/Zepp login failed: invalid email or password");
}

function rateLimitError(responseBody: string): Error {
  return new Error(`Amazfit/Zepp login failed: ${responseBody}`);
}

async function parseJsonRegistrationResponse(
  response: Response,
): Promise<Pick<ZeppAccessCredentials, "accessCode" | "countryCode"> | null> {
  const responseBody = await response.text();
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(responseBody);
  } catch {
    return null;
  }

  const payload = zeppRegistrationJsonSchema.parse(parsedBody);
  if (!payload.access) return null;

  return {
    accessCode: payload.access,
    countryCode: payload.country_code ?? "US",
  };
}

async function getLegacyRegistrationCredentials(
  email: string,
  password: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<ZeppAccessCredentials | null> {
  const authUrl = registrationUrl(email);
  const registrationBody = new URLSearchParams({
    state: "REDIRECTION",
    client_id: "HuaMi",
    redirect_uri: ZEPP_REGISTRATION_REDIRECT_URI,
    token: "access",
    json_response: "true",
    name: email,
    country_code: "US",
    password,
  });

  const registrationResponse = await fetchFn(authUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": `MiFit/${ZEPP_APP_VERSION} (android_phone; Android 15; Density/2.75)`,
      app_name: ZEPP_APP_NAME,
    },
    body: registrationBody.toString(),
    redirect: "manual",
  });

  if (registrationResponse.status === 429) {
    throw rateLimitError(await registrationResponse.text());
  }

  if (registrationResponse.status === 200) {
    const credentials = await parseJsonRegistrationResponse(registrationResponse);
    if (!credentials) return null;
    return {
      ...credentials,
      loginUrl: ZEPP_ACCOUNT_LOGIN_URL,
      thirdName: "huami",
      dn: "account.huami.com,api-user.huami.com,api-watch.huami.com,api-analytics.huami.com,app-analytics.huami.com,api-mifit.huami.com",
    };
  }

  if (registrationResponse.status === 302 || registrationResponse.status === 303) {
    const location = registrationResponse.headers.get("location");
    if (!location) return null;
    try {
      return {
        ...parseRedirectCredentials(location, authUrl),
        loginUrl: ZEPP_ACCOUNT_LOGIN_URL,
        thirdName: "huami",
        dn: "account.huami.com,api-user.huami.com,api-watch.huami.com,api-analytics.huami.com,app-analytics.huami.com,api-mifit.huami.com",
      };
    } catch {
      return null;
    }
  }

  if (isRetryableLegacyRegistrationStatus(registrationResponse.status)) {
    await registrationResponse.text();
    return null;
  }

  throw new Error(`Amazfit/Zepp login failed (${registrationResponse.status})`);
}

async function getEncryptedRegistrationCredentials(
  email: string,
  password: string,
  fetchFn: typeof globalThis.fetch,
): Promise<ZeppAccessCredentials> {
  const registrationBody = new URLSearchParams({
    emailOrPhone: email,
    password,
    state: "REDIRECTION",
    client_id: "HuaMi",
    country_code: "US",
    token: "access",
    redirect_uri: ZEPP_REGISTRATION_REDIRECT_URI,
  });

  const registrationResponse = await fetchFn(ZEPP_ENCRYPTED_REGISTRATION_URL, {
    method: "POST",
    headers: zeppClientHeaders(),
    body: encryptZeppRegistrationBody(registrationBody),
    redirect: "manual",
  });

  if (registrationResponse.status === 429) {
    throw rateLimitError(await registrationResponse.text());
  }

  if (registrationResponse.status !== 302 && registrationResponse.status !== 303) {
    await registrationResponse.text();
    throw invalidCredentialsError();
  }

  const location = registrationResponse.headers.get("location");
  if (!location) {
    throw invalidCredentialsError();
  }

  const { accessCode, countryCode } = parseRedirectCredentials(
    location,
    ZEPP_ENCRYPTED_REGISTRATION_URL,
  );
  return {
    accessCode,
    countryCode,
    loginUrl: ZEPP_ACCOUNT_ZEPP_LOGIN_URL,
    thirdName: "email",
    source: `${ZEPP_APP_NAME}:${ZEPP_APP_VERSION}:50818`,
    dn: "account.zepp.com,api-user.zepp.com,api-mifit.zepp.com,api-watch.zepp.com,app-analytics.zepp.com,api-analytics.huami.com,auth.zepp.com",
  };
}

async function exchangeAccessCodeForToken(
  credentials: ZeppAccessCredentials,
  fetchFn: typeof globalThis.fetch,
): Promise<ZeppSignInResult> {
  const loginBody = new URLSearchParams({
    app_name: ZEPP_APP_NAME,
    dn: credentials.dn,
    device_id: "02:00:00:00:00:00",
    device_model: "android_phone",
    app_version: ZEPP_APP_VERSION,
    allow_registration: "false",
    third_name: credentials.thirdName,
    grant_type: "access_token",
    country_code: credentials.countryCode,
    code: credentials.accessCode,
  });
  if (credentials.source) {
    loginBody.set("source", credentials.source);
    loginBody.set("lang", "en");
  }

  const loginResponse = await fetchFn(credentials.loginUrl, {
    method: "POST",
    headers: {
      ...zeppClientHeaders(),
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
    body: loginBody.toString(),
  });

  const responseBody = await loginResponse.text();

  if (!loginResponse.ok) {
    throw new Error(`Amazfit/Zepp login error (${loginResponse.status})`);
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(responseBody);
  } catch {
    throw new Error("Amazfit/Zepp login error: unexpected non-JSON response from Zepp");
  }

  const payload = zeppLoginResponseSchema.parse(parsedBody);
  const tokenInfo = payload.token_info;
  if (!tokenInfo) {
    throw new Error(
      payload.message ?? payload.result ?? "Amazfit/Zepp login failed: missing token_info",
    );
  }

  return {
    appToken: tokenInfo.app_token,
    userId: tokenInfo.user_id,
    loginToken: tokenInfo.login_token ?? null,
  };
}

export async function signInToZepp(
  email: string,
  password: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<ZeppSignInResult> {
  const legacyCredentials = await getLegacyRegistrationCredentials(email, password, fetchFn);
  const credentials =
    legacyCredentials ?? (await getEncryptedRegistrationCredentials(email, password, fetchFn));
  return exchangeAccessCodeForToken(credentials, fetchFn);
}
