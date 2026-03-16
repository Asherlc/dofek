import type { TrainerRoadActivity, TrainerRoadCareer, TrainerRoadMemberInfo } from "./types.ts";

const TRAINERROAD_BASE = "https://www.trainerroad.com";

export class TrainerRoadClient {
  private authCookie: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(authCookie: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.authCookie = authCookie;
    this.fetchFn = fetchFn;
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${TRAINERROAD_BASE}${path}`;
    const response = await this.fetchFn(url, {
      headers: {
        Cookie: `SharedTrainerRoadAuth=${this.authCookie}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`TrainerRoad API error (${response.status}): ${text}`);
    }

    return response.json();
  }

  async getMemberInfo(): Promise<TrainerRoadMemberInfo> {
    return this.get<TrainerRoadMemberInfo>("/app/api/member-info");
  }

  async getActivities(
    username: string,
    startDate: string,
    endDate: string,
  ): Promise<TrainerRoadActivity[]> {
    return this.get<TrainerRoadActivity[]>(
      `/app/api/calendar/activities/${username}?startDate=${startDate}&endDate=${endDate}`,
    );
  }

  async getCareer(username: string): Promise<TrainerRoadCareer> {
    return this.get<TrainerRoadCareer>(`/app/api/career/${username}/new`);
  }

  static async signIn(
    username: string,
    password: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<{ authCookie: string; username: string }> {
    // First, get the CSRF token from the login page
    const loginPageResponse = await fetchFn(`${TRAINERROAD_BASE}/app/login`, {
      redirect: "manual",
    });
    const loginPageHtml = await loginPageResponse.text();

    // Extract __RequestVerificationToken from the page
    const tokenMatch = loginPageHtml.match(/name="__RequestVerificationToken"\s+value="([^"]+)"/);
    const csrfToken = tokenMatch?.[1] ?? "";

    // Extract cookies from the login page response
    const pageCookies = loginPageResponse.headers.getSetCookie?.() ?? [];
    const cookieHeader = pageCookies.map((c) => c.split(";")[0]).join("; ");

    // Submit login form
    const loginResponse = await fetchFn(`${TRAINERROAD_BASE}/app/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader,
      },
      body: new URLSearchParams({
        Username: username,
        Password: password,
        __RequestVerificationToken: csrfToken,
      }),
      redirect: "manual",
    });

    // Extract auth cookie from response
    const responseCookies = loginResponse.headers.getSetCookie?.() ?? [];
    const authCookieEntry = responseCookies.find((c) => c.startsWith("SharedTrainerRoadAuth="));
    if (!authCookieEntry) {
      throw new Error("TrainerRoad login failed — no auth cookie returned");
    }

    const authCookieValue = authCookieEntry.split("=")[1]?.split(";")[0] ?? "";

    // Get username from member info
    const client = new TrainerRoadClient(authCookieValue, fetchFn);
    const memberInfo = await client.getMemberInfo();

    return { authCookie: authCookieValue, username: memberInfo.Username };
  }
}
