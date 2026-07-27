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
      `Invalid ZOHO_DESK_DATA_CENTER "${dataCenterRaw}". Expected one of: ${Object.keys(DATA_CENTER_DOMAINS).join(", ")}`,
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
const ticketSearchResponseSchema = z.object({
  count: z.coerce.number().int().nonnegative(),
  data: z.array(
    z.object({
      description: z.string().nullable(),
      id: z.string().min(1),
    }),
  ),
});
const recycleBinListResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
});
const recycleBinDeleteResponseSchema = z.object({
  results: z.array(
    z.object({
      id: z.string().min(1),
      success: z.boolean(),
    }),
  ),
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

const TOKEN_EXPIRY_SKEW_MS = 60_000;
const TICKET_SEARCH_PAGE_SIZE = 100;
const TICKET_SEARCH_MAX_RESULTS = 5_000;
const RECYCLE_BIN_PAGE_SIZE = 100;

function hasDofekUserFooter(description: string | null, userId: string): boolean {
  if (description === null) return false;
  const lines = description.replace(/\r\n?/g, "\n").trimEnd().split("\n");
  const footer = lines.slice(-3);
  return (
    footer.length === 3 &&
    footer[0] === "---" &&
    footer[1] === `User ID: ${userId}` &&
    footer[2]?.startsWith("App version: ") === true
  );
}

export class ZohoDeskError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ZohoDeskError";
    this.status = status;
  }
}

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

  #authorizedHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      orgId: this.#config.orgId,
    };
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
    this.#accessTokenExpiresAt = Date.now() + parsed.expires_in * 1_000 - TOKEN_EXPIRY_SKEW_MS;
    return parsed.access_token;
  }

  async createTicket(input: SupportTicketInput): Promise<CreatedTicket> {
    const accessToken = await this.#getAccessToken();
    const response = await fetch(`https://${this.#domains.desk}/api/v1/tickets`, {
      method: "POST",
      headers: {
        ...this.#authorizedHeaders(accessToken),
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

  async listTicketIdsByDofekUserId(userId: string): Promise<string[]> {
    const parsedUserId = z.uuid().parse(userId);
    const ticketIds = new Set<string>();
    let from = 0;
    for (;;) {
      const url = new URL(`https://${this.#domains.desk}/api/v1/tickets/search`);
      url.searchParams.set("description", `User ID: ${parsedUserId}`);
      url.searchParams.set("from", String(from));
      url.searchParams.set("limit", String(TICKET_SEARCH_PAGE_SIZE));
      const response = await fetch(url, {
        headers: this.#authorizedHeaders(await this.#getAccessToken()),
      });
      if (!response.ok) {
        throw new ZohoDeskError(
          `Zoho legacy ticket search failed with status ${response.status}`,
          response.status,
        );
      }
      const result = ticketSearchResponseSchema.parse(await response.json());
      if (result.count > TICKET_SEARCH_MAX_RESULTS) {
        throw new ZohoDeskError(
          `Zoho legacy ticket search exceeded ${TICKET_SEARCH_MAX_RESULTS} results`,
          response.status,
        );
      }
      for (const ticket of result.data) {
        if (hasDofekUserFooter(ticket.description, parsedUserId)) {
          ticketIds.add(ticket.id);
        }
      }
      const nextFrom = from + result.data.length;
      if (nextFrom >= result.count) return [...ticketIds];
      if (result.data.length === 0 || nextFrom >= TICKET_SEARCH_MAX_RESULTS) {
        throw new ZohoDeskError(
          "Zoho legacy ticket search could not make progress",
          response.status,
        );
      }
      from = nextFrom;
    }
  }

  async #ticketIsActive(ticketId: string, accessToken: string): Promise<boolean> {
    const response = await fetch(
      `https://${this.#domains.desk}/api/v1/tickets/${encodeURIComponent(ticketId)}`,
      { headers: this.#authorizedHeaders(accessToken) },
    );
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new ZohoDeskError(
        `Zoho ticket lookup failed with status ${response.status}`,
        response.status,
      );
    }
    return true;
  }

  async #ticketIsInRecycleBin(ticketId: string, accessToken: string): Promise<boolean> {
    let from = 0;
    for (;;) {
      const url = new URL(`https://${this.#domains.desk}/api/v1/recycleBin`);
      url.searchParams.set("module", "tickets");
      url.searchParams.set("from", String(from));
      url.searchParams.set("limit", String(RECYCLE_BIN_PAGE_SIZE));
      const response = await fetch(url, {
        headers: this.#authorizedHeaders(accessToken),
      });
      if (!response.ok) {
        throw new ZohoDeskError(
          `Zoho recycle-bin lookup failed with status ${response.status}`,
          response.status,
        );
      }
      const resources = recycleBinListResponseSchema.parse(await response.json()).data;
      if (resources.some((resource) => resource.id === ticketId)) return true;
      if (resources.length < RECYCLE_BIN_PAGE_SIZE) return false;
      from += resources.length;
    }
  }

  async #permanentlyDeleteTicket(ticketId: string, accessToken: string): Promise<void> {
    const response = await fetch(`https://${this.#domains.desk}/api/v1/recycleBin/delete`, {
      method: "POST",
      headers: {
        ...this.#authorizedHeaders(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids: [ticketId] }),
    });
    if (!response.ok) {
      throw new ZohoDeskError(
        `Zoho permanent ticket deletion failed with status ${response.status}`,
        response.status,
      );
    }
    const result = recycleBinDeleteResponseSchema
      .parse(await response.json())
      .results.find((entry) => entry.id === ticketId);
    if (!result?.success) {
      throw new ZohoDeskError(
        `Zoho did not confirm permanent deletion of ticket ${ticketId}`,
        response.status,
      );
    }
  }

  async deleteTicket(ticketId: string): Promise<void> {
    const parsedTicketId = z.string().min(1).parse(ticketId);
    const accessToken = await this.#getAccessToken();
    if (await this.#ticketIsActive(parsedTicketId, accessToken)) {
      const response = await fetch(`https://${this.#domains.desk}/api/v1/tickets/moveToTrash`, {
        method: "POST",
        headers: {
          ...this.#authorizedHeaders(accessToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ticketIds: [parsedTicketId] }),
      });
      if (!response.ok) {
        throw new ZohoDeskError(
          `Zoho ticket move-to-trash failed with status ${response.status}`,
          response.status,
        );
      }
    } else if (!(await this.#ticketIsInRecycleBin(parsedTicketId, accessToken))) {
      return;
    }
    await this.#permanentlyDeleteTicket(parsedTicketId, accessToken);
  }
}

let cachedClient: ZohoDeskClient | null = null;

export function getZohoDeskClient(): ZohoDeskClient {
  cachedClient ??= new ZohoDeskClient(zohoDeskConfigFromEnv());
  return cachedClient;
}
