import { describe, expect, it, vi } from "vitest";
import {
  signInToZepp,
  ZEPP_ACCOUNT_LOGIN_URL,
  ZEPP_ACCOUNT_ZEPP_LOGIN_URL,
  ZEPP_APP_NAME,
  ZEPP_ENCRYPTED_REGISTRATION_URL,
  ZEPP_REGISTRATION_REDIRECT_URI,
  ZeppInvalidCredentialsError,
} from "./client.ts";

type MockFetch = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

function mockFetch(handlers: {
  registration?: Response | Error;
  encryptedRegistration?: Response | Error;
  login?: Response | Error;
  zeppLogin?: Response | Error;
}): MockFetch {
  return vi.fn(async (input) => {
    const url = String(input);
    if (url === ZEPP_ENCRYPTED_REGISTRATION_URL) {
      if (handlers.encryptedRegistration instanceof Error) throw handlers.encryptedRegistration;
      if (handlers.encryptedRegistration) return handlers.encryptedRegistration;
      throw new Error(`Unexpected encrypted registration request: ${url}`);
    }
    if (url.includes("/registrations/")) {
      if (handlers.registration instanceof Error) throw handlers.registration;
      if (handlers.registration) return handlers.registration;
      throw new Error(`Unexpected registration request: ${url}`);
    }
    if (url === ZEPP_ACCOUNT_ZEPP_LOGIN_URL) {
      if (handlers.zeppLogin instanceof Error) throw handlers.zeppLogin;
      if (handlers.zeppLogin) return handlers.zeppLogin;
      throw new Error(`Unexpected Zepp login request: ${url}`);
    }
    if (url === ZEPP_ACCOUNT_LOGIN_URL) {
      if (handlers.login instanceof Error) throw handlers.login;
      if (handlers.login) return handlers.login;
      throw new Error(`Unexpected login request: ${url}`);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

describe("signInToZepp", () => {
  it("exchanges JSON registration access code for app token and user id", async () => {
    const fetchFn = mockFetch({
      registration: Response.json({
        access: "json-access-code",
        country_code: "US",
      }),
      login: new Response(
        JSON.stringify({
          token_info: {
            app_token: "app-token-json",
            user_id: "987654321",
            login_token: "login-token-json",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    });

    const result = await signInToZepp("user@example.com", "secret-pass", fetchFn);

    expect(result).toEqual({
      appToken: "app-token-json",
      userId: "987654321",
      loginToken: "login-token-json",
    });

    const [registrationUrl, registrationInit] = fetchFn.mock.calls[0] ?? [];
    expect(String(registrationUrl)).toBe(
      "https://api-user.huami.com/registrations/user%40example.com/tokens",
    );
    const registrationBody = new URLSearchParams(String(registrationInit?.body));
    expect(registrationBody.get("json_response")).toBe("true");
    expect(registrationBody.get("name")).toBe("user@example.com");

    const [, loginInit] = fetchFn.mock.calls[1] ?? [];
    const loginBody = new URLSearchParams(String(loginInit?.body));
    expect(loginBody.get("country_code")).toBe("US");
    expect(loginBody.get("code")).toBe("json-access-code");
    expect(loginBody.has("source")).toBe(false);
    expect(loginBody.has("lang")).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("defaults JSON registration country code to US when Zepp omits it", async () => {
    const fetchFn = mockFetch({
      registration: Response.json({ access: "json-access-code" }),
      login: new Response(
        JSON.stringify({
          token_info: {
            app_token: "app-token-json",
            user_id: "987654321",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    });

    await signInToZepp("user@example.com", "secret-pass", fetchFn);

    const [, loginInit] = fetchFn.mock.calls[1] ?? [];
    const loginBody = new URLSearchParams(String(loginInit?.body));
    expect(loginBody.get("country_code")).toBe("US");
  });

  it("exchanges email credentials for app token and user id", async () => {
    const fetchFn = mockFetch({
      registration: new Response(null, {
        status: 302,
        headers: {
          Location: `${ZEPP_REGISTRATION_REDIRECT_URI}?access=access-code-123&country_code=US`,
        },
      }),
      login: new Response(
        JSON.stringify({
          token_info: {
            app_token: "app-token-456",
            user_id: "987654321",
            login_token: "login-token-789",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    });

    const result = await signInToZepp("user@example.com", "secret-pass", fetchFn);

    expect(result).toEqual({
      appToken: "app-token-456",
      userId: "987654321",
      loginToken: "login-token-789",
    });

    const [registrationUrl, registrationInit] = fetchFn.mock.calls[0] ?? [];
    expect(String(registrationUrl)).toBe(
      "https://api-user.huami.com/registrations/user%40example.com/tokens",
    );
    expect(registrationInit).toMatchObject({
      method: "POST",
      redirect: "manual",
    });
    expect(String(registrationInit?.body)).toContain("password=secret-pass");

    const [, loginInit] = fetchFn.mock.calls[1] ?? [];
    const loginBody = new URLSearchParams(String(loginInit?.body));
    expect(loginBody.get("app_name")).toBe(ZEPP_APP_NAME);
    expect(loginBody.get("country_code")).toBe("US");
    expect(loginBody.get("code")).toBe("access-code-123");
  });

  it("coerces numeric user ids to strings", async () => {
    const fetchFn = mockFetch({
      registration: new Response(null, {
        status: 302,
        headers: {
          Location: `${ZEPP_REGISTRATION_REDIRECT_URI}?access=access-code&country_code=CN`,
        },
      }),
      login: new Response(
        JSON.stringify({
          token_info: {
            app_token: "app-token",
            user_id: 12345,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    });

    const result = await signInToZepp("user@example.com", "password", fetchFn);
    expect(result.userId).toBe("12345");
    expect(result.loginToken).toBeNull();
  });

  it("throws when registration redirect is missing credentials", async () => {
    const fetchFn = mockFetch({
      registration: new Response(null, {
        status: 302,
        headers: { Location: ZEPP_REGISTRATION_REDIRECT_URI },
      }),
      encryptedRegistration: new Response(null, {
        status: 302,
        headers: { Location: ZEPP_REGISTRATION_REDIRECT_URI },
      }),
    });

    await expect(signInToZepp("user@example.com", "bad-password", fetchFn)).rejects.toBeInstanceOf(
      ZeppInvalidCredentialsError,
    );
  });

  it("falls back to encrypted Zepp registration when JSON registration is null", async () => {
    const fetchFn = mockFetch({
      registration: Response.json(null),
      encryptedRegistration: new Response(null, {
        status: 303,
        headers: {
          Location: `${ZEPP_REGISTRATION_REDIRECT_URI}?access=encrypted-access&country_code=US`,
        },
      }),
      zeppLogin: new Response(
        JSON.stringify({
          token_info: {
            app_token: "encrypted-app-token",
            user_id: "encrypted-user",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    });

    const result = await signInToZepp("user@example.com", "password", fetchFn);

    expect(result.appToken).toBe("encrypted-app-token");
    expect(String(fetchFn.mock.calls[1]?.[0])).toBe(ZEPP_ENCRYPTED_REGISTRATION_URL);
  });

  it("falls back to encrypted Zepp registration when JSON registration is malformed", async () => {
    const fetchFn = mockFetch({
      registration: new Response("<html>not json</html>", { status: 200 }),
      encryptedRegistration: new Response(null, {
        status: 303,
        headers: {
          Location: `${ZEPP_REGISTRATION_REDIRECT_URI}?access=encrypted-access&country_code=US`,
        },
      }),
      zeppLogin: new Response(
        JSON.stringify({
          token_info: {
            app_token: "encrypted-app-token",
            user_id: "encrypted-user",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    });

    const result = await signInToZepp("user@example.com", "password", fetchFn);

    expect(result.appToken).toBe("encrypted-app-token");
    expect(String(fetchFn.mock.calls[1]?.[0])).toBe(ZEPP_ENCRYPTED_REGISTRATION_URL);
  });

  it("falls back to encrypted Zepp registration when JSON registration lacks access", async () => {
    const fetchFn = mockFetch({
      registration: Response.json({ country_code: "US" }),
      encryptedRegistration: new Response(null, {
        status: 303,
        headers: {
          Location: `${ZEPP_REGISTRATION_REDIRECT_URI}?access=encrypted-access&country_code=US`,
        },
      }),
      zeppLogin: new Response(
        JSON.stringify({
          token_info: {
            app_token: "encrypted-app-token",
            user_id: "encrypted-user",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    });

    const result = await signInToZepp("user@example.com", "password", fetchFn);

    expect(result.userId).toBe("encrypted-user");
    expect(String(fetchFn.mock.calls[1]?.[0])).toBe(ZEPP_ENCRYPTED_REGISTRATION_URL);
  });

  it("throws when login response lacks token_info", async () => {
    const fetchFn = mockFetch({
      registration: new Response(null, {
        status: 302,
        headers: {
          Location: `${ZEPP_REGISTRATION_REDIRECT_URI}?access=access-code&country_code=US`,
        },
      }),
      login: new Response(JSON.stringify({ message: "login denied" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });

    await expect(signInToZepp("user@example.com", "password", fetchFn)).rejects.toThrow(
      "login denied",
    );
  });

  it("throws when registration does not redirect", async () => {
    const fetchFn = mockFetch({
      registration: new Response("invalid credentials", { status: 401 }),
      encryptedRegistration: new Response("invalid credentials", { status: 401 }),
    });

    await expect(signInToZepp("user@example.com", "password", fetchFn)).rejects.toBeInstanceOf(
      ZeppInvalidCredentialsError,
    );
  });

  it("falls back to encrypted Zepp registration when legacy registration returns 403", async () => {
    const fetchFn = mockFetch({
      registration: new Response("legacy denied", { status: 403 }),
      encryptedRegistration: new Response(null, {
        status: 303,
        headers: {
          Location: `${ZEPP_REGISTRATION_REDIRECT_URI}?access=encrypted-access&country_code=US`,
        },
      }),
      zeppLogin: new Response(
        JSON.stringify({
          token_info: {
            app_token: "encrypted-app-token",
            user_id: "encrypted-user",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    });

    const result = await signInToZepp("user@example.com", "password", fetchFn);

    expect(result.appToken).toBe("encrypted-app-token");
    expect(String(fetchFn.mock.calls[1]?.[0])).toBe(ZEPP_ENCRYPTED_REGISTRATION_URL);
  });

  it("does not fall back to encrypted Zepp registration after unexpected legacy status", async () => {
    const fetchFn = mockFetch({
      registration: new Response("maintenance", { status: 503 }),
    });

    await expect(signInToZepp("user@example.com", "password", fetchFn)).rejects.toThrow(
      "Amazfit/Zepp login failed (503)",
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("falls back to encrypted Zepp registration when legacy registration is missing location", async () => {
    const fetchFn = mockFetch({
      registration: new Response(null, { status: 302 }),
      encryptedRegistration: new Response(null, {
        status: 303,
        headers: {
          Location: `${ZEPP_REGISTRATION_REDIRECT_URI}?access=encrypted-access&country_code=US`,
        },
      }),
      zeppLogin: new Response(
        JSON.stringify({
          token_info: {
            app_token: "encrypted-app-token",
            user_id: "encrypted-user",
            login_token: "encrypted-login-token",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    });

    const result = await signInToZepp("user@example.com", "password", fetchFn);

    expect(result).toEqual({
      appToken: "encrypted-app-token",
      userId: "encrypted-user",
      loginToken: "encrypted-login-token",
    });
    expect(String(fetchFn.mock.calls[1]?.[0])).toBe(ZEPP_ENCRYPTED_REGISTRATION_URL);
    const encryptedInit = fetchFn.mock.calls[1]?.[1];
    expect(encryptedInit?.headers).toMatchObject({
      "x-hm-ekv": "1",
      app_name: ZEPP_APP_NAME,
      appname: ZEPP_APP_NAME,
      appplatform: "android_phone",
    });
    const encryptedBody = encryptedInit?.body;
    expect(encryptedBody).toBeInstanceOf(Uint8Array);
    expect(encryptedBody).toHaveProperty("byteLength", expect.any(Number));
    if (!(encryptedBody instanceof Uint8Array)) throw new Error("expected encrypted body");
    expect(encryptedBody.byteLength).toBeGreaterThan(16);
    expect(String(fetchFn.mock.calls[2]?.[0])).toBe(ZEPP_ACCOUNT_ZEPP_LOGIN_URL);
    const [, encryptedLoginInit] = fetchFn.mock.calls[2] ?? [];
    const encryptedLoginBody = new URLSearchParams(String(encryptedLoginInit?.body));
    expect(encryptedLoginBody.get("source")).toBe(`${ZEPP_APP_NAME}:6.14.0:50818`);
    expect(encryptedLoginBody.get("lang")).toBe("en");
    expect(encryptedLoginBody.get("third_name")).toBe("email");
  });

  it("does not fall back to encrypted registration after a legacy rate limit", async () => {
    const fetchFn = mockFetch({
      registration: new Response(JSON.stringify({ code: 12, message: "too many requests" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    });

    await expect(signInToZepp("user@example.com", "password", fetchFn)).rejects.toMatchObject({
      message: 'Amazfit/Zepp login failed: {"code":12,"message":"too many requests"}',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not fall back after an encrypted registration rate limit", async () => {
    const fetchFn = mockFetch({
      registration: new Response(null, { status: 302 }),
      encryptedRegistration: new Response("too many requests", { status: 429 }),
    });

    await expect(signInToZepp("user@example.com", "password", fetchFn)).rejects.toMatchObject({
      message: "Amazfit/Zepp login failed: too many requests",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("throws invalid credentials when encrypted registration returns a non-redirect", async () => {
    const fetchFn = mockFetch({
      registration: new Response(null, { status: 302 }),
      encryptedRegistration: new Response("denied", { status: 401 }),
    });

    await expect(signInToZepp("user@example.com", "password", fetchFn)).rejects.toBeInstanceOf(
      ZeppInvalidCredentialsError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("retries legacy login on account.zepp.com when account.huami.com returns 403", async () => {
    const fetchFn = mockFetch({
      registration: new Response(null, {
        status: 302,
        headers: {
          Location: `${ZEPP_REGISTRATION_REDIRECT_URI}?access=access-code&country_code=US`,
        },
      }),
      login: new Response("denied", { status: 403 }),
      zeppLogin: new Response(
        JSON.stringify({
          token_info: {
            app_token: "app-token-456",
            user_id: "987654321",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    });

    const result = await signInToZepp("user@example.com", "password", fetchFn);

    expect(result.appToken).toBe("app-token-456");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("retries legacy login on account.zepp.com when account.huami.com returns 400", async () => {
    const fetchFn = mockFetch({
      registration: Response.json({
        access: "json-access-code",
        country_code: "US",
      }),
      login: new Response("bad request", { status: 400 }),
      zeppLogin: new Response(
        JSON.stringify({
          token_info: {
            app_token: "app-token-json",
            user_id: "987654321",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    });

    const result = await signInToZepp("user@example.com", "password", fetchFn);

    expect(result).toEqual({
      appToken: "app-token-json",
      userId: "987654321",
      loginToken: null,
    });
    expect(String(fetchFn.mock.calls[1]?.[0])).toBe(ZEPP_ACCOUNT_LOGIN_URL);
    expect(String(fetchFn.mock.calls[2]?.[0])).toBe(ZEPP_ACCOUNT_ZEPP_LOGIN_URL);
    const [, zeppLoginInit] = fetchFn.mock.calls[2] ?? [];
    const zeppLoginBody = new URLSearchParams(String(zeppLoginInit?.body));
    expect(zeppLoginBody.get("third_name")).toBe("email");
    expect(zeppLoginBody.get("source")).toBe(`${ZEPP_APP_NAME}:6.14.0:50818`);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("falls back to encrypted registration when legacy login fails on every endpoint", async () => {
    let loginAttempts = 0;
    const fetchFn = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/registrations/") && !url.includes("v2/registrations/tokens")) {
        return Response.json({ access: "json-access-code", country_code: "US" });
      }
      if (url === ZEPP_ENCRYPTED_REGISTRATION_URL) {
        return new Response(null, {
          status: 303,
          headers: {
            Location: `${ZEPP_REGISTRATION_REDIRECT_URI}?access=encrypted-access&country_code=US`,
          },
        });
      }
      if (url === ZEPP_ACCOUNT_LOGIN_URL || url === ZEPP_ACCOUNT_ZEPP_LOGIN_URL) {
        loginAttempts += 1;
        if (loginAttempts <= 2) {
          return new Response("bad request", { status: 400 });
        }
        return new Response(
          JSON.stringify({
            token_info: {
              app_token: "encrypted-app-token",
              user_id: "encrypted-user",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await signInToZepp("user@example.com", "password", fetchFn);

    expect(result.appToken).toBe("encrypted-app-token");
    expect(loginAttempts).toBe(3);
    expect(String(fetchFn.mock.calls.find(([url]) => String(url) === ZEPP_ENCRYPTED_REGISTRATION_URL)?.[0])).toBe(
      ZEPP_ENCRYPTED_REGISTRATION_URL,
    );
  });

  it("throws when login response body is not JSON", async () => {
    const fetchFn = mockFetch({
      registration: new Response(null, {
        status: 302,
        headers: {
          Location: `${ZEPP_REGISTRATION_REDIRECT_URI}?access=access-code&country_code=US`,
        },
      }),
      login: new Response("<html>maintenance</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    });

    await expect(signInToZepp("user@example.com", "password", fetchFn)).rejects.toThrow(
      "unexpected non-JSON response from Zepp",
    );
  });
});
