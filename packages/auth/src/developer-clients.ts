import { z } from "zod";

export const DEVELOPER_CLIENT_SCOPES = ["nutrition:write"] as const;

export type DeveloperClientScope = (typeof DEVELOPER_CLIENT_SCOPES)[number];
export type DeveloperClientStatus = "active" | "revoked";

export interface DeveloperClientSummary {
  clientId: string;
  name: string;
  scopes: DeveloperClientScope[];
  status: DeveloperClientStatus;
  createdAt: string;
  lastRotatedAt: string;
}

export interface DeveloperClientDetail extends DeveloperClientSummary {
  redirectUris: string[];
}

export interface DeveloperClientSecret {
  client: DeveloperClientDetail;
  clientSecret: string;
}

export function canonicalizeDeveloperRedirectUri(value: string): string {
  if (value.includes("#")) {
    throw new Error("Redirect URIs must not contain a fragment.");
  }
  const redirectUri = new URL(value);
  if (redirectUri.protocol !== "https:") {
    throw new Error("Redirect URIs must use HTTPS.");
  }
  if (redirectUri.username || redirectUri.password) {
    throw new Error("Redirect URIs must not contain credentials.");
  }
  return redirectUri.href;
}

const redirectUriSchema = z.string().transform((value, context) => {
  try {
    return canonicalizeDeveloperRedirectUri(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Enter a valid HTTPS redirect URI.",
    });
    return z.NEVER;
  }
});

const redirectUriSetSchema = z
  .array(redirectUriSchema)
  .min(1, "Add at least one redirect URI.")
  .superRefine((redirectUris, context) => {
    const seen = new Set<string>();
    redirectUris.forEach((redirectUri, index) => {
      if (seen.has(redirectUri)) {
        context.addIssue({
          code: "custom",
          message: "Redirect URIs must be unique.",
          path: [index],
        });
      }
      seen.add(redirectUri);
    });
  });

const nameSchema = z.string().trim().min(1, "Enter an integration name.");
const scopesSchema = z.tuple([z.literal("nutrition:write")]);
const timestampSchema = z.iso.datetime({ offset: true });

export const DeveloperClientInputSchema = z
  .object({
    name: nameSchema,
    redirectUris: redirectUriSetSchema,
    scopes: scopesSchema,
  })
  .strict();

export const DeveloperClientUpdateSchema = z
  .object({
    name: nameSchema,
    redirectUris: redirectUriSetSchema,
  })
  .strict();

export type DeveloperClientInput = z.infer<typeof DeveloperClientInputSchema>;
export type DeveloperClientUpdate = z.infer<typeof DeveloperClientUpdateSchema>;

export const DeveloperClientSummarySchema: z.ZodType<DeveloperClientSummary> = z
  .object({
    clientId: z.string().min(1),
    name: z.string().min(1),
    scopes: z.array(z.literal("nutrition:write")).length(1),
    status: z.enum(["active", "revoked"]),
    createdAt: timestampSchema,
    lastRotatedAt: timestampSchema,
  })
  .strict();

export const DeveloperClientDetailSchema: z.ZodType<DeveloperClientDetail> =
  DeveloperClientSummarySchema.and(
    z
      .object({
        redirectUris: z.array(z.string()).min(1),
      })
      .strict(),
  );

export const DeveloperClientSecretSchema: z.ZodType<DeveloperClientSecret> = z
  .object({
    client: DeveloperClientDetailSchema,
    clientSecret: z.string().min(1),
  })
  .strict();

export const DeveloperApiProblemSchema = z
  .object({
    type: z.url(),
    title: z.string().min(1),
    status: z.number().int().min(400).max(599),
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1),
    details: z.array(z.unknown()),
  })
  .strict();

export type DeveloperApiProblem = z.infer<typeof DeveloperApiProblemSchema>;

export class DeveloperClientsApiError extends Error {
  readonly code: string;
  readonly details: unknown[];
  readonly requestId: string | null;
  readonly status: number;

  constructor(input: {
    code: string;
    details?: unknown[];
    message: string;
    requestId?: string | null;
    status: number;
  }) {
    super(input.message);
    this.name = "DeveloperClientsApiError";
    this.code = input.code;
    this.details = input.details ?? [];
    this.requestId = input.requestId ?? null;
    this.status = input.status;
  }
}

export type DeveloperClientsRequest = (path: string, init: RequestInit) => Promise<Response>;

export interface DeveloperClientsApi {
  list(): Promise<DeveloperClientSummary[]>;
  create(input: DeveloperClientInput): Promise<DeveloperClientSecret>;
  get(clientId: string): Promise<DeveloperClientDetail>;
  update(clientId: string, input: DeveloperClientUpdate): Promise<DeveloperClientDetail>;
  rotate(clientId: string): Promise<DeveloperClientSecret>;
  revoke(clientId: string): Promise<{ revoked: true }>;
}

const developerClientListSchema = z.array(DeveloperClientSummarySchema);
const developerClientRevokedSchema = z.object({ revoked: z.literal(true) }).strict();

async function parseResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const problem = DeveloperApiProblemSchema.safeParse(body);
    if (!problem.success) {
      throw new DeveloperClientsApiError({
        code: "INVALID_RESPONSE",
        message: "The server returned an invalid response.",
        status: response.status,
      });
    }
    throw new DeveloperClientsApiError({
      code: problem.data.code,
      details: problem.data.details,
      message: problem.data.message,
      requestId: problem.data.requestId,
      status: response.status,
    });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new DeveloperClientsApiError({
      code: "INVALID_RESPONSE",
      message: "The server returned an invalid response.",
      status: response.status,
    });
  }
  return parsed.data;
}

function requestInit(method: "GET" | "PATCH" | "POST", body?: unknown): RequestInit {
  return {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

export function createDeveloperClientsApi(request: DeveloperClientsRequest): DeveloperClientsApi {
  const basePath = "/api/developer/clients";
  const clientPath = (clientId: string) => `${basePath}/${encodeURIComponent(clientId)}`;

  return {
    async list() {
      return parseResponse(await request(basePath, requestInit("GET")), developerClientListSchema);
    },
    async create(input) {
      const body = DeveloperClientInputSchema.parse(input);
      return parseResponse(
        await request(basePath, requestInit("POST", body)),
        DeveloperClientSecretSchema,
      );
    },
    async get(clientId) {
      return parseResponse(
        await request(clientPath(clientId), requestInit("GET")),
        DeveloperClientDetailSchema,
      );
    },
    async update(clientId, input) {
      const body = DeveloperClientUpdateSchema.parse(input);
      return parseResponse(
        await request(clientPath(clientId), requestInit("PATCH", body)),
        DeveloperClientDetailSchema,
      );
    },
    async rotate(clientId) {
      return parseResponse(
        await request(`${clientPath(clientId)}/rotate`, requestInit("POST")),
        DeveloperClientSecretSchema,
      );
    },
    async revoke(clientId) {
      return parseResponse(
        await request(`${clientPath(clientId)}/revoke`, requestInit("POST")),
        developerClientRevokedSchema,
      );
    },
  };
}
