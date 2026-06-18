import { describe, expect, it, vi } from "vitest";
import {
  signInToZepp,
  ZEPP_ACCOUNT_LOGIN_URL,
  ZEPP_APP_NAME,
  ZEPP_REGISTRATION_REDIRECT_URI,
} from "./client.ts";

function mockFetch(handlers: {
  registration?: Response | Error;
  login?: Response | Error;
}): typeof globalThis.fetch {
  return vi.fn(async (input) => {
    const url = String(input);
    if (url.includes("/registrations/")) {
      if (handlers.registration instanceof Error) throw handlers.registration;
      if (handlers.registration) return handlers.registration;
      throw new Error(`Unexpected registration request: ${url}`);
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
    });

    await expect(signInToZepp("user@example.com", "password", fetchFn)).rejects.toThrow(
      "Amazfit/Zepp login failed (401)",
    );
  });

  it("throws when registration redirect is missing location", async () => {
    const fetchFn = mockFetch({
      registration: new Response(null, { status: 302 }),
    });

    await expect(signInToZepp("user@example.com", "password", fetchFn)).rejects.toThrow(
      "missing redirect location",
    );
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
});
