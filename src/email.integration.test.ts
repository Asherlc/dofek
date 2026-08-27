import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sendPlainTextEmail } from "./email.ts";
import { failOnUnhandledExternalRequest } from "./test/msw.ts";

const BREVO_EMAIL_URL = "https://api.brevo.com/v3/smtp/email";
const envBackup = { ...process.env };
const server = setupServer();

function setEmailEnv(): void {
  process.env.BREVO_API_KEY = "brevo-api-key";
  process.env.EXPORT_EMAIL_FROM = "dofek@dofek.fit";
}

describe("shared email", () => {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
  });

  beforeEach(() => {
    process.env = { ...envBackup };
  });

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(() => {
    server.close();
    process.env = envBackup;
  });

  it("fails loudly when the Brevo API key is missing", async () => {
    process.env.EXPORT_EMAIL_FROM = "dofek@dofek.fit";

    await expect(
      sendPlainTextEmail({
        subject: "Subject",
        text: "Body",
        toEmail: "user@example.com",
      }),
    ).rejects.toThrow("BREVO_API_KEY");
  });

  it("sends a plain text email through the Brevo API", async () => {
    setEmailEnv();
    server.use(
      http.post(BREVO_EMAIL_URL, async ({ request }) => {
        expect(request.headers.get("api-key")).toBe("brevo-api-key");
        expect(await request.json()).toEqual({
          sender: { email: "dofek@dofek.fit" },
          subject: "Subject",
          textContent: "Body",
          to: [{ email: "user@example.com" }],
        });
        return HttpResponse.json({ messageId: "brevo-message-id" }, { status: 201 });
      }),
    );

    await expect(
      sendPlainTextEmail({
        subject: "Subject",
        text: "Body",
        toEmail: "user@example.com",
      }),
    ).resolves.toBeUndefined();
  });

  it("fails loudly when Brevo rejects the email", async () => {
    setEmailEnv();
    server.use(
      http.post(BREVO_EMAIL_URL, () =>
        HttpResponse.json({ code: "invalid_parameter" }, { status: 400 }),
      ),
    );

    await expect(
      sendPlainTextEmail({
        subject: "Subject",
        text: "Body",
        toEmail: "user@example.com",
      }),
    ).rejects.toThrow("Brevo email request failed with status 400");
  });
});
