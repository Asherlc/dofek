import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSendMail = vi.fn().mockResolvedValue({});
const mockCreateTransport = vi.fn(() => ({ sendMail: mockSendMail }));

vi.mock("nodemailer", () => ({
  default: { createTransport: mockCreateTransport },
}));

const envBackup = { ...process.env };

async function loadEmailModule() {
  vi.resetModules();
  return import("./email.ts");
}

function setEmailEnv() {
  process.env.BREVO_SMTP_USER = "smtp-user";
  process.env.BREVO_SMTP_KEY = "smtp-key";
  process.env.EXPORT_EMAIL_FROM = "dofek@dofek.fit";
}

describe("shared email", () => {
  beforeEach(() => {
    process.env = { ...envBackup };
    vi.clearAllMocks();
    mockSendMail.mockResolvedValue({});
  });

  it("fails loudly when Brevo configuration is missing", async () => {
    const { sendPlainTextEmail } = await loadEmailModule();
    setEmailEnv();
    delete process.env.BREVO_SMTP_KEY;

    await expect(
      sendPlainTextEmail({
        subject: "Subject",
        text: "Body",
        toEmail: "user@example.com",
      }),
    ).rejects.toThrow("BREVO_SMTP_KEY");
  });

  it("sends a plain text email through Brevo SMTP", async () => {
    setEmailEnv();
    const { sendPlainTextEmail } = await loadEmailModule();

    await sendPlainTextEmail({
      subject: "Subject",
      text: "Body",
      toEmail: "user@example.com",
    });

    expect(mockCreateTransport).toHaveBeenCalledWith({
      auth: { pass: "smtp-key", user: "smtp-user" },
      host: "smtp-relay.brevo.com",
      port: 587,
      secure: false,
    });
    expect(mockSendMail).toHaveBeenCalledWith({
      from: "dofek@dofek.fit",
      subject: "Subject",
      text: "Body",
      to: "user@example.com",
    });
  });
});
