import { z } from "zod";
import type { ZeppSignInResult } from "./types.ts";

export const ZEPP_REGISTRATION_REDIRECT_URI =
  "https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html";
export const ZEPP_ACCOUNT_LOGIN_URL = "https://account.huami.com/v2/client/login";
export const ZEPP_APP_NAME = "com.xiaomi.hm.health";

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

function registrationUrl(email: string): string {
  return `https://api-user.huami.com/registrations/${encodeURIComponent(email)}/tokens`;
}

function parseRedirectCredentials(location: string, baseUrl: string): { accessCode: string; countryCode: string } {
  const redirectUrl = new URL(location, baseUrl);
  const accessCode = redirectUrl.searchParams.get("access");
  const countryCode = redirectUrl.searchParams.get("country_code");
  if (!accessCode || !countryCode) {
    throw new Error("Amazfit/Zepp login failed: invalid email or password");
  }
  return { accessCode, countryCode };
}

export class ZeppClient {
  static async signIn(
    email: string,
    password: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<ZeppSignInResult> {
    const authUrl = registrationUrl(email);
    const registrationBody = new URLSearchParams({
      state: "REDIRECTION",
      client_id: "HuaMi",
      redirect_uri: ZEPP_REGISTRATION_REDIRECT_URI,
      token: "access",
      password,
    });

    const registrationResponse = await fetchFn(authUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: registrationBody.toString(),
      redirect: "manual",
    });

    if (registrationResponse.status !== 302 && registrationResponse.status !== 303) {
      const text = await registrationResponse.text();
      throw new Error(
        `Amazfit/Zepp login failed (${registrationResponse.status}): ${text || "unexpected response"}`,
      );
    }

    const location = registrationResponse.headers.get("location");
    if (!location) {
      throw new Error("Amazfit/Zepp login failed: missing redirect location");
    }

    const { accessCode, countryCode } = parseRedirectCredentials(location, authUrl);

    const loginBody = new URLSearchParams({
      app_name: ZEPP_APP_NAME,
      dn: "account.huami.com,api-user.huami.com,api-watch.huami.com,api-analytics.huami.com,app-analytics.huami.com,api-mifit.huami.com",
      device_id: "02:00:00:00:00:00",
      device_model: "android_phone",
      app_version: "6.12.0",
      allow_registration: "false",
      third_name: "huami",
      grant_type: "access_token",
      country_code: countryCode,
      code: accessCode,
    });

    const loginResponse = await fetchFn(ZEPP_ACCOUNT_LOGIN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: loginBody.toString(),
    });

    if (!loginResponse.ok) {
      const text = await loginResponse.text();
      throw new Error(`Amazfit/Zepp login error (${loginResponse.status}): ${text}`);
    }

    const payload = zeppLoginResponseSchema.parse(await loginResponse.json());
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
}
