import { createCipheriv, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ZeppSignInResult } from "./types.ts";

export const ZEPP_REGISTRATION_REDIRECT_URI =
  "https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html";
export const ZEPP_ENCRYPTED_REGISTRATION_URL =
  "https://api-user-us2.zepp.com/v2/registrations/tokens";

const ZEPP_AES_KEY = "xeNtBVqzDc6tuNTh";
const ZEPP_AES_IV = "MAAAYAAAAAAAAABg";
const CURRENT_ZEPP_APP_NAME = "com.huami.midong";
const CURRENT_ZEPP_APP_VERSION = "9.12.5";
const CURRENT_ZEPP_CLIENT_VERSION = "151689";
const CURRENT_ZEPP_BUILD_VERSION = "202509151347";
const CURRENT_ZEPP_LOGIN_URL = "https://api-mifit-us2.zepp.com/v2/client/login";
const CURRENT_ZEPP_DN =
  "api-mifit.zepp.com,api-user.zepp.com,api-mifit.zepp.com,api-watch.zepp.com,app-analytics.zepp.com,auth.zepp.com,api-analytics.zepp.com";

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

export class ZeppInvalidCredentialsError extends Error {
  constructor(options?: ErrorOptions) {
    super("Amazfit/Zepp login failed: invalid email or password", options);
    this.name = new.target.name;
  }
}

export class ZeppLoginExchangeError extends Error {
  readonly status: number;

  constructor(status: number, options?: ErrorOptions) {
    super(`Amazfit/Zepp login error (${status})`, options);
    this.name = new.target.name;
    this.status = status;
  }
}

interface ZeppAccessCredentials {
  accessCode: string;
  appName: string;
  appVersion: string;
  countryCode: string;
  countryState: string;
  deviceId: string;
  headers: Record<string, string>;
  loginUrl: string;
  thirdName: string;
  source?: string;
  dn: string;
}

function parseRedirectCredentials(
  location: string,
  baseUrl: string,
): Pick<ZeppAccessCredentials, "accessCode" | "countryCode"> {
  const redirectUrl = new URL(location, baseUrl);
  const accessCode = redirectUrl.searchParams.get("access");
  const countryCode = redirectUrl.searchParams.get("country_code");
  if (!accessCode || !countryCode) {
    throw new ZeppInvalidCredentialsError();
  }
  return { accessCode, countryCode };
}

function encryptZeppRegistrationBody(body: URLSearchParams): Uint8Array<ArrayBuffer> {
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(ZEPP_AES_KEY), Buffer.from(ZEPP_AES_IV));
  const encrypted = Buffer.concat([cipher.update(body.toString(), "utf8"), cipher.final()]);
  return new Uint8Array(encrypted);
}

function currentZeppRegistrationHeaders(): Record<string, string> {
  return {
    "accept-encoding": "gzip",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    "user-agent": `Zepp/${CURRENT_ZEPP_APP_VERSION} (Pixel 4; Android 12; Density/2.75)`,
    app_name: CURRENT_ZEPP_APP_NAME,
    appname: CURRENT_ZEPP_APP_NAME,
    appplatform: "android_phone",
    cv: `${CURRENT_ZEPP_CLIENT_VERSION}_${CURRENT_ZEPP_APP_VERSION}`,
    v: "2.0",
    vb: CURRENT_ZEPP_BUILD_VERSION,
    vn: CURRENT_ZEPP_APP_VERSION,
    "x-hm-ekv": "1",
  };
}

function currentZeppLoginHeaders(): Record<string, string> {
  return {
    "accept-language": "en-US,en;q=0.5",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
    accept: "application/json, text/plain, */*",
    app_name: "com.huami.webapp",
    appname: "com.huami.webapp",
    origin: "https://user.zepp.com",
    referer: "https://user.zepp.com/",
  };
}

function invalidCredentialsError(options?: ErrorOptions): ZeppInvalidCredentialsError {
  return new ZeppInvalidCredentialsError(options);
}

function rateLimitError(responseBody: string): Error {
  return new Error(`Amazfit/Zepp login failed: ${responseBody}`);
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
    region: "us-west-2",
    country_code: "US",
    redirect_uri: ZEPP_REGISTRATION_REDIRECT_URI,
  });
  registrationBody.append("token", "access");
  registrationBody.append("token", "refresh");

  const registrationResponse = await fetchFn(ZEPP_ENCRYPTED_REGISTRATION_URL, {
    method: "POST",
    headers: currentZeppRegistrationHeaders(),
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
    appName: CURRENT_ZEPP_APP_NAME,
    appVersion: CURRENT_ZEPP_APP_VERSION,
    countryCode,
    countryState: "US-NY",
    deviceId: randomUUID(),
    headers: currentZeppLoginHeaders(),
    loginUrl: CURRENT_ZEPP_LOGIN_URL,
    thirdName: "huami",
    source: `com.huami.watch.hmwatchmanager:${CURRENT_ZEPP_APP_VERSION}:${CURRENT_ZEPP_CLIENT_VERSION}`,
    dn: CURRENT_ZEPP_DN,
  };
}

async function performTokenExchange(
  credentials: ZeppAccessCredentials,
  fetchFn: typeof globalThis.fetch,
): Promise<ZeppSignInResult> {
  const loginBody = new URLSearchParams({
    app_name: credentials.appName,
    dn: credentials.dn,
    device_id: credentials.deviceId,
    device_model: "android_phone",
    app_version: credentials.appVersion,
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
  loginBody.set("countryState", credentials.countryState);

  const loginResponse = await fetchFn(credentials.loginUrl, {
    method: "POST",
    headers: credentials.headers,
    body: loginBody.toString(),
  });

  const responseBody = await loginResponse.text();

  if (!loginResponse.ok) {
    throw new ZeppLoginExchangeError(loginResponse.status);
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

async function exchangeAccessCodeForToken(
  credentials: ZeppAccessCredentials,
  fetchFn: typeof globalThis.fetch,
): Promise<ZeppSignInResult> {
  return await performTokenExchange(credentials, fetchFn);
}

export async function signInToZepp(
  email: string,
  password: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<ZeppSignInResult> {
  const encryptedCredentials = await getEncryptedRegistrationCredentials(email, password, fetchFn);
  return await exchangeAccessCodeForToken(encryptedCredentials, fetchFn);
}
