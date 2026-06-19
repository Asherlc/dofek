import { describe, expect, it, vi } from "vitest";
import {
  signInToZepp,
  ZEPP_ENCRYPTED_REGISTRATION_URL,
  ZEPP_REGISTRATION_REDIRECT_URI,
  ZeppInvalidCredentialsError,
  ZeppLoginExchangeError,
} from "./client.ts";

type MockFetch = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

const CURRENT_ZEPP_LOGIN_URL = "https://api-mifit-us2.zepp.com/v2/client/login";
const CURRENT_ZEPP_REGISTRATION_URL = "https://api-user-us2.zepp.com/v2/registrations/tokens";

function mockFetch(handlers: {
  encryptedRegistration?: Response | Error;
  currentLogin?: Response | Error;
}): MockFetch {
  return vi.fn(async (input) => {
    const url = String(input);
    if (url === ZEPP_ENCRYPTED_REGISTRATION_URL) {
      if (handlers.encryptedRegistration instanceof Error) throw handlers.encryptedRegistration;
      if (handlers.encryptedRegistration) return handlers.encryptedRegistration;
      throw new Error(`Unexpected encrypted registration request: ${url}`);
    }
    if (url === CURRENT_ZEPP_LOGIN_URL) {
      if (handlers.currentLogin instanceof Error) throw handlers.currentLogin;
      if (handlers.currentLogin) return handlers.currentLogin;
      throw new Error(`Unexpected current Zepp login request: ${url}`);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function successfulRegistrationResponse(): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${ZEPP_REGISTRATION_REDIRECT_URI}?access=encrypted-access&refresh=refresh-token&country_code=US&countryState=&expiration=1782740151`,
    },
  });
}

function successfulLoginResponse(userId: string | number = "987654321"): Response {
  return new Response(
    JSON.stringify({
      token_info: {
        app_token: "app-token-456",
        user_id: userId,
        login_token: "login-token-789",
        ttl: 31_536_000,
        app_ttl: 2_592_000,
      },
      result: "ok",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("signInToZepp", () => {
  it("uses the current Zepp US2 registration and token exchange flow", async () => {
    const fetchFn = mockFetch({
      encryptedRegistration: successfulRegistrationResponse(),
      currentLogin: successfulLoginResponse(),
    });

    const result = await signInToZepp("user@example.com", "secret-pass", fetchFn);

    expect(result).toEqual({
      appToken: "app-token-456",
      userId: "987654321",
      loginToken: "login-token-789",
    });

    const [registrationUrl, registrationInit] = fetchFn.mock.calls[0] ?? [];
    expect(String(registrationUrl)).toBe(CURRENT_ZEPP_REGISTRATION_URL);
    expect(registrationInit).toMatchObject({ method: "POST", redirect: "manual" });
    expect(registrationInit?.headers).toMatchObject({
      "accept-encoding": "gzip",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      app_name: "com.huami.midong",
      appname: "com.huami.midong",
      appplatform: "android_phone",
      cv: "151689_9.12.5",
      v: "2.0",
      vb: "202509151347",
      vn: "9.12.5",
      "x-hm-ekv": "1",
    });
    expect(registrationInit?.body).toBeInstanceOf(Uint8Array);
    if (!(registrationInit?.body instanceof Uint8Array)) {
      throw new Error("expected encrypted registration body");
    }
    expect(registrationInit.body.byteLength).toBeGreaterThan(16);

    const [loginUrl, loginInit] = fetchFn.mock.calls[1] ?? [];
    expect(String(loginUrl)).toBe(CURRENT_ZEPP_LOGIN_URL);
    expect(loginInit?.headers).toMatchObject({
      accept: "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.5",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      app_name: "com.huami.webapp",
      appname: "com.huami.webapp",
      origin: "https://user.zepp.com",
      referer: "https://user.zepp.com/",
    });

    const loginBody = new URLSearchParams(String(loginInit?.body));
    expect(loginBody.get("app_name")).toBe("com.huami.midong");
    expect(loginBody.get("app_version")).toBe("9.12.5");
    expect(loginBody.get("code")).toBe("encrypted-access");
    expect(loginBody.get("countryState")).toBe("US-NY");
    expect(loginBody.get("device_id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(loginBody.get("dn")).toBe(
      "api-mifit.zepp.com,api-user.zepp.com,api-mifit.zepp.com,api-watch.zepp.com,app-analytics.zepp.com,auth.zepp.com,api-analytics.zepp.com",
    );
    expect(loginBody.get("source")).toBe("com.huami.watch.hmwatchmanager:9.12.5:151689");
    expect(loginBody.get("third_name")).toBe("huami");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("coerces numeric user ids to strings", async () => {
    const fetchFn = mockFetch({
      encryptedRegistration: successfulRegistrationResponse(),
      currentLogin: successfulLoginResponse(12345),
    });

    const result = await signInToZepp("user@example.com", "password", fetchFn);

    expect(result.userId).toBe("12345");
  });

  it("throws invalid credentials when registration redirect is missing credentials", async () => {
    const fetchFn = mockFetch({
      encryptedRegistration: new Response(null, {
        status: 303,
        headers: { Location: ZEPP_REGISTRATION_REDIRECT_URI },
      }),
    });

    await expect(signInToZepp("user@example.com", "bad-password", fetchFn)).rejects.toBeInstanceOf(
      ZeppInvalidCredentialsError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not continue after a registration rate limit", async () => {
    const fetchFn = mockFetch({
      encryptedRegistration: new Response("too many requests", { status: 429 }),
    });

    await expect(signInToZepp("user@example.com", "password", fetchFn)).rejects.toMatchObject({
      message: "Amazfit/Zepp login failed: too many requests",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws invalid credentials when registration returns a non-redirect", async () => {
    const fetchFn = mockFetch({
      encryptedRegistration: new Response("denied", { status: 401 }),
    });

    await expect(signInToZepp("user@example.com", "password", fetchFn)).rejects.toBeInstanceOf(
      ZeppInvalidCredentialsError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws the provider message when login response lacks token_info", async () => {
    const fetchFn = mockFetch({
      encryptedRegistration: successfulRegistrationResponse(),
      currentLogin: new Response(JSON.stringify({ message: "login denied" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });

    await expect(signInToZepp("user@example.com", "password", fetchFn)).rejects.toThrow(
      "login denied",
    );
  });

  it("keeps token exchange bad requests distinct from invalid credentials", async () => {
    const fetchFn = mockFetch({
      encryptedRegistration: successfulRegistrationResponse(),
      currentLogin: new Response("bad request", { status: 400 }),
    });

    const error = await signInToZepp("user@example.com", "password", fetchFn).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ZeppLoginExchangeError);
    expect(error).toMatchObject({ status: 400 });
    expect(error).not.toBeInstanceOf(ZeppInvalidCredentialsError);
  });

  it("throws when login response body is not JSON", async () => {
    const fetchFn = mockFetch({
      encryptedRegistration: successfulRegistrationResponse(),
      currentLogin: new Response("<html>maintenance</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    });

    await expect(signInToZepp("user@example.com", "password", fetchFn)).rejects.toThrow(
      "unexpected non-JSON response from Zepp",
    );
  });
});
