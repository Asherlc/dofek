import { z } from "zod";

/**
 * Zoho data centers map to distinct OAuth (`accounts`) and Desk API domains.
 * See https://www.zoho.com/desk/developers-guide/ (multi-DC section).
 */
const DATA_CENTER_DOMAINS = {
  us: { accounts: "accounts.zoho.com", desk: "desk.zoho.com" },
  eu: { accounts: "accounts.zoho.eu", desk: "desk.zoho.eu" },
  in: { accounts: "accounts.zoho.in", desk: "desk.zoho.in" },
  au: { accounts: "accounts.zoho.com.au", desk: "desk.zoho.com.au" },
  jp: { accounts: "accounts.zoho.jp", desk: "desk.zoho.jp" },
} as const;

export type ZohoDataCenter = keyof typeof DATA_CENTER_DOMAINS;

function isDataCenter(value: string): value is ZohoDataCenter {
  return value in DATA_CENTER_DOMAINS;
}

export interface ZohoDeskConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  orgId: string;
  departmentId: string;
  dataCenter: ZohoDataCenter;
}

/**
 * Read and validate Zoho Desk configuration from the environment. Fails loudly
 * with the exact missing keys rather than continuing in a degraded state.
 */
export function zohoDeskConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ZohoDeskConfig {
  const required = {
    ZOHO_DESK_CLIENT_ID: env.ZOHO_DESK_CLIENT_ID,
    ZOHO_DESK_CLIENT_SECRET: env.ZOHO_DESK_CLIENT_SECRET,
    ZOHO_DESK_REFRESH_TOKEN: env.ZOHO_DESK_REFRESH_TOKEN,
    ZOHO_DESK_ORG_ID: env.ZOHO_DESK_ORG_ID,
    ZOHO_DESK_DEPARTMENT_ID: env.ZOHO_DESK_DEPARTMENT_ID,
  };

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Missing required Zoho Desk environment variables: ${missing.join(", ")}`);
  }

  const parsed = z
    .object({
      ZOHO_DESK_CLIENT_ID: z.string().min(1),
      ZOHO_DESK_CLIENT_SECRET: z.string().min(1),
      ZOHO_DESK_REFRESH_TOKEN: z.string().min(1),
      ZOHO_DESK_ORG_ID: z.string().min(1),
      ZOHO_DESK_DEPARTMENT_ID: z.string().min(1),
    })
    .parse(required);

  const dataCenterRaw = (env.ZOHO_DESK_DATA_CENTER ?? "us").toLowerCase();
  if (!isDataCenter(dataCenterRaw)) {
    throw new Error(
      `Invalid ZOHO_DESK_DATA_CENTER "${dataCenterRaw}". Expected one of: ${Object.keys(
        DATA_CENTER_DOMAINS,
      ).join(", ")}`,
    );
  }

  return {
    clientId: parsed.ZOHO_DESK_CLIENT_ID,
    clientSecret: parsed.ZOHO_DESK_CLIENT_SECRET,
    refreshToken: parsed.ZOHO_DESK_REFRESH_TOKEN,
    orgId: parsed.ZOHO_DESK_ORG_ID,
    departmentId: parsed.ZOHO_DESK_DEPARTMENT_ID,
    dataCenter: dataCenterRaw,
  };
}

const tokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
});

const createTicketResponseSchema = z.object({
  id: z.string(),
  ticketNumber: z.string(),
});

export interface SupportTicketInput {
  subject: string;
  description: string;
  contactEmail: string;
  contactName: string;
}

export interface CreatedTicket {
  id: string;
  ticketNumber: string;
}

/** Refresh access tokens slightly early to avoid using a token that expires mid-request. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

export class ZohoDeskError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ZohoDeskError";
    this.status = status;
  }
}

/**
 * Minimal Zoho Desk API client: refreshes a short-lived OAuth access token
 * (cached in-memory until it nears expiry) and creates support tickets.
 */
export class ZohoDeskClient {
  #accessToken: string | null = null;
  #accessTokenExpiresAt = 0;
  readonly #config: ZohoDeskConfig;

  constructor(config: ZohoDeskConfig) {
    this.#config = config;
  }

  get #domains() {
    return DATA_CENTER_DOMAINS[this.#config.dataCenter];
  }

  async #getAccessToken(): Promise<string> {
    if (this.#accessToken && Date.now() < this.#accessTokenExpiresAt) {
      return this.#accessToken;
    }

    const params = new URLSearchParams({
      refresh_token: this.#config.refreshToken,
      client_id: this.#config.clientId,
      client_secret: this.#config.clientSecret,
      grant_type: "refresh_token",
    });

    const response = await fetch(`https://${this.#domains.accounts}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new ZohoDeskError(
        `Zoho token refresh failed with status ${response.status}`,
        response.status,
      );
    }

    const parsed = tokenResponseSchema.parse(await response.json());
    this.#accessToken = parsed.access_token;
    this.#accessTokenExpiresAt = Date.now() + parsed.expires_in * 1000 - TOKEN_EXPIRY_SKEW_MS;
    return parsed.access_token;
  }

  async createTicket(input: SupportTicketInput): Promise<CreatedTicket> {
    const accessToken = await this.#getAccessToken();

    const response = await fetch(`https://${this.#domains.desk}/api/v1/tickets`, {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        orgId: this.#config.orgId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subject: input.subject,
        description: input.description,
        departmentId: this.#config.departmentId,
        contact: {
          email: input.contactEmail,
          lastName: input.contactName,
        },
      }),
    });

    if (!response.ok) {
      throw new ZohoDeskError(
        `Zoho ticket creation failed with status ${response.status}`,
        response.status,
      );
    }

    return createTicketResponseSchema.parse(await response.json());
  }
}

let cachedClient: ZohoDeskClient | null = null;

/** Lazily construct a process-wide Zoho Desk client from environment config. */
export function getZohoDeskClient(): ZohoDeskClient {
  if (!cachedClient) {
    cachedClient = new ZohoDeskClient(zohoDeskConfigFromEnv());
  }
  return cachedClient;
}
