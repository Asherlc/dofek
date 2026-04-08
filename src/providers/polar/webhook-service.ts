import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { WebhookEvent } from "../types.ts";

const POLAR_WEBHOOK_URL = "https://www.polaraccesslink.com/v3/webhooks";

const webhookPayloadSchema = z.object({
  event: z.string(),
  user_id: z.coerce.string(),
  entity_id: z.string().optional(),
  timestamp: z.string().optional(),
});

const webhookObjectTypeByEvent: Record<string, string> = {
  EXERCISE: "activity",
  SLEEP: "sleep",
  CONTINUOUS_HEART_RATE: "heart_rate",
};

export class PolarWebhookService {
  readonly #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  async registerWebhook(
    callbackUrl: string,
  ): Promise<{ subscriptionId: string; signingSecret?: string; expiresAt?: Date }> {
    const clientId = process.env.POLAR_CLIENT_ID;
    const clientSecret = process.env.POLAR_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("POLAR_CLIENT_ID and POLAR_CLIENT_SECRET are required");
    }

    const response = await this.#fetchFn(POLAR_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: JSON.stringify({
        events: [
          { event: "EXERCISE", url: callbackUrl },
          { event: "SLEEP", url: callbackUrl },
          { event: "CONTINUOUS_HEART_RATE", url: callbackUrl },
        ],
      }),
    });

    if (!response.ok) {
      const textBody = await response.text();
      throw new Error(`Polar webhook registration failed (${response.status}): ${textBody}`);
    }

    const responseBody: { data?: { id?: string; signature_secret_key?: string } } =
      await response.json();
    return {
      subscriptionId: responseBody.data?.id ?? "polar-webhook",
      signingSecret: responseBody.data?.signature_secret_key,
    };
  }

  async unregisterWebhook(subscriptionId: string): Promise<void> {
    const clientId = process.env.POLAR_CLIENT_ID;
    const clientSecret = process.env.POLAR_CLIENT_SECRET;
    if (!clientId || !clientSecret) return;

    await this.#fetchFn(`${POLAR_WEBHOOK_URL}/${subscriptionId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
    });
  }

  verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    signingSecret: string,
  ): boolean {
    const signatureHeader = headers["polar-webhook-signature"];
    if (!signatureHeader || typeof signatureHeader !== "string") return false;

    const signatureHmac = createHmac("sha256", signingSecret);
    signatureHmac.update(rawBody);
    const expectedSignature = signatureHmac.digest("hex");

    try {
      return timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expectedSignature));
    } catch {
      return false;
    }
  }

  parseWebhookPayload(body: unknown): WebhookEvent[] {
    const parsedBody = webhookPayloadSchema.safeParse(body);
    if (!parsedBody.success) return [];

    const payload = parsedBody.data;
    return [
      {
        ownerExternalId: String(payload.user_id),
        eventType: "create",
        objectType: webhookObjectTypeByEvent[payload.event] ?? payload.event.toLowerCase(),
        objectId: payload.entity_id,
      },
    ];
  }
}
