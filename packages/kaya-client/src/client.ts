import { z } from "zod";

export const KAYA_API_URL = "https://kaya-beta.kayaclimb.com";
const KAYA_APP_URL = "https://kaya-app.kayaclimb.com";
const PAGE_SIZE = 100;

const idSchema = z.union([z.string(), z.number()]).transform(String);
const gymSchema = z.object({ id: idSchema, name: z.string() });
const sessionSchema = z.object({
  id: idSchema,
  start_time: z.string(),
  end_time: z.string().nullable(),
  gym: gymSchema.nullable(),
});
const ascentSchema = z.object({
  id: idSchema,
  session_id: idSchema.nullable(),
  date: z.string(),
  attempts: z.number().int().positive().nullable(),
  ascent_type: z.object({ id: idSchema, name: z.string() }),
  climb: z.object({
    id: idSchema,
    name: z.string().nullable(),
    lead: z.boolean(),
    climb_type: z.object({ id: idSchema, name: z.string() }),
    grade: z.object({ id: idSchema, name: z.string(), climb_type_group: z.string() }).nullable(),
    gym: gymSchema.nullable(),
  }),
});

export type KayaSession = z.infer<typeof sessionSchema>;
export type KayaAscent = z.infer<typeof ascentSchema>;

export class KayaInvalidCredentialsError extends Error {
  constructor(options?: ErrorOptions) {
    super("Kaya rejected the email or password", options);
    this.name = new.target.name;
  }
}

export class KayaApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}

export async function signInToKaya(
  email: string,
  password: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  const response = await fetchFn(`${KAYA_API_URL}/api/user/login`, {
    method: "POST",
    headers: browserHeaders(),
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new KayaInvalidCredentialsError();
  const payload: unknown = await response.json();
  const parsed = z
    .object({
      message: z.literal("ok"),
      token: z.string(),
      refresh_token: z.string(),
      user: z.object({ id: idSchema }),
    })
    .safeParse(payload);
  if (!parsed.success) throw new KayaInvalidCredentialsError();
  return {
    accessToken: parsed.data.token,
    refreshToken: parsed.data.refresh_token,
    userId: parsed.data.user.id,
  };
}

export class KayaClient {
  readonly accessToken: string;
  readonly fetchFn: typeof fetch;

  constructor(accessToken: string, fetchFn: typeof fetch = globalThis.fetch) {
    this.accessToken = accessToken;
    this.fetchFn = fetchFn;
  }

  listSessions(userId: string): Promise<KayaSession[]> {
    return this.#list(userId, "sessionsForUser", SESSION_QUERY, sessionSchema);
  }

  listAscents(userId: string): Promise<KayaAscent[]> {
    return this.#list(userId, "ascentsForUser", ASCENT_QUERY, ascentSchema);
  }

  async #list<T>(
    userId: string,
    field: "sessionsForUser" | "ascentsForUser",
    query: string,
    itemSchema: z.ZodType<T>,
  ): Promise<T[]> {
    const items: T[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const response = await this.fetchFn(`${KAYA_API_URL}/graphql`, {
        method: "POST",
        headers: { ...browserHeaders(), authorization: `Bearer ${this.accessToken}` },
        body: JSON.stringify({ query, variables: { user_id: userId, offset, count: PAGE_SIZE } }),
      });
      if (!response.ok)
        throw new KayaApiError(`Kaya API request failed (${response.status})`, response.status);
      const payload: unknown = await response.json();
      const envelope = z
        .object({
          data: z.object({ [field]: z.array(itemSchema) }).optional(),
          errors: z.array(z.object({ message: z.string() })).optional(),
        })
        .parse(payload);
      if (envelope.errors?.length)
        throw new KayaApiError(envelope.errors.map(({ message }) => message).join("; "));
      const page = envelope.data?.[field] ?? [];
      items.push(...page);
      if (page.length < PAGE_SIZE) return items;
    }
  }
}

function browserHeaders(): Record<string, string> {
  return { "content-type": "application/json", origin: KAYA_APP_URL, referer: `${KAYA_APP_URL}/` };
}

const SESSION_QUERY = `query sessionsForUser($user_id: ID!, $offset: Int!, $count: Int!) { sessionsForUser(user_id: $user_id, offset: $offset, count: $count) { id start_time end_time gym { id name } } }`;
const ASCENT_QUERY = `query ascentsForUser($user_id: ID!, $offset: Int!, $count: Int!) { ascentsForUser(user_id: $user_id, offset: $offset, count: $count) { id session_id date attempts ascent_type { id name } climb { id name lead climb_type { id name } grade { id name climb_type_group } gym { id name } } } }`;
