import { describe, expect, it } from "vitest";
import { zohoDeskConfigFromEnv } from "./zoho-desk.ts";

const completeEnv: NodeJS.ProcessEnv = {
  ZOHO_DESK_CLIENT_ID: "client-id",
  ZOHO_DESK_CLIENT_SECRET: "client-secret",
  ZOHO_DESK_REFRESH_TOKEN: "refresh-token",
  ZOHO_DESK_ORG_ID: "929149487",
  ZOHO_DESK_DEPARTMENT_ID: "dept-id",
};

describe("zohoDeskConfigFromEnv", () => {
  it("parses a complete environment and defaults the data center to US", () => {
    const config = zohoDeskConfigFromEnv(completeEnv);
    expect(config).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
      orgId: "929149487",
      departmentId: "dept-id",
      dataCenter: "us",
    });
  });

  it("honors an explicit data center", () => {
    const config = zohoDeskConfigFromEnv({ ...completeEnv, ZOHO_DESK_DATA_CENTER: "EU" });
    expect(config.dataCenter).toBe("eu");
  });

  it("lists every missing required variable", () => {
    expect(() => zohoDeskConfigFromEnv({ ZOHO_DESK_CLIENT_ID: "only-this" })).toThrow(
      /ZOHO_DESK_CLIENT_SECRET.*ZOHO_DESK_REFRESH_TOKEN.*ZOHO_DESK_ORG_ID.*ZOHO_DESK_DEPARTMENT_ID/,
    );
  });

  it("rejects an unknown data center", () => {
    expect(() => zohoDeskConfigFromEnv({ ...completeEnv, ZOHO_DESK_DATA_CENTER: "mars" })).toThrow(
      /Invalid ZOHO_DESK_DATA_CENTER/,
    );
  });
});
