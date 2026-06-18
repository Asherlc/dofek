import { describe, expect, it, vi } from "vitest";
import {
  signInToZepp,
  ZEPP_ACCOUNT_LOGIN_URL,
  ZEPP_ACCOUNT_ZEPP_LOGIN_URL,
  ZEPP_APP_NAME,
  ZEPP_ENCRYPTED_REGISTRATION_URL,
  ZEPP_REGISTRATION_REDIRECT_URI,
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
    expect(fetchFn).toHaveBeenCalledTimes(2);
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

    await expect(signInToZepp("user@example.com", "bad-password", fetchFn)).rejects.toThrow(
      "invalid email or password",
    );
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

    await expect(signInToZepp("user@example.com", "password", fetchFn)).rejects.toThrow(
      "invalid email or password",
    );
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
    const encryptedBody = fetchFn.mock.calls[1]?.[1]?.body;
    expect(encryptedBody).toBeInstanceOf(Uint8Array);
    expect(String(fetchFn.mock.calls[2]?.[0])).toBe(ZEPP_ACCOUNT_ZEPP_LOGIN_URL);
  });

  it("does not fall back to encrypted registration after a legacy rate limit", async () => {
    const fetchFn = mockFetch({
      registration: new Response(JSON.stringify({ code: 12, message: "too many requests" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    });

    await expect(signInToZepp("user@example.com", "password", fetchFn)).rejects.toThrow(
      "too many requests",
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws when login HTTP response is not ok", async () => {
    const fetchFn = mockFetch({
      registration: new Response(null, {
        status: 302,
        headers: {
          Location: `${ZEPP_REGISTRATION_REDIRECT_URI}?access=access-code&country_code=US`,
        },
      }),
      login: new Response("denied", { status: 403 }),
    });

    await expect(signInToZepp("user@example.com", "password", fetchFn)).rejects.toThrow(
      "Amazfit/Zepp login error (403)",
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
