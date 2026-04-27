import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSendMail = vi.fn().mockResolvedValue({});
const mockCreateTransport = vi.fn(() => ({ sendMail: mockSendMail }));

vi.mock("nodemailer", () => ({
  default: { createTransport: mockCreateTransport },
}));

const envBackup = { ...process.env };

async function loadEmailModule() {
  vi.resetModules();
  return import("./export-email.ts");
}

function setEmailEnv() {
  process.env.BREVO_SMTP_USER = "smtp-user";
  process.env.BREVO_SMTP_KEY = "smtp-key";
  process.env.EXPORT_EMAIL_FROM = "dofek@dofek.fit";
}

describe("export email", () => {
  beforeEach(() => {
    process.env = { ...envBackup };
    vi.clearAllMocks();
    mockSendMail.mockResolvedValue({});
  });

  it("fails loudly when Brevo configuration is missing", async () => {
    const { sendExportReadyEmail } = await loadEmailModule();
    setEmailEnv();
    delete process.env.BREVO_SMTP_KEY;

    await expect(
      sendExportReadyEmail({
        downloadUrl: "https://example.test/export",
        expiresAt: new Date("2026-05-03T12:00:00.000Z"),
        toEmail: "user@example.com",
      }),
    ).rejects.toThrow("BREVO_SMTP_KEY");
  });

  it("sends a Brevo SMTP email with the signed export URL", async () => {
    setEmailEnv();
    const { sendExportReadyEmail } = await loadEmailModule();

    await sendExportReadyEmail({
      downloadUrl: "https://example.test/export",
      expiresAt: new Date("2026-05-03T12:00:00.000Z"),
      toEmail: "user@example.com",
    });

    expect(mockCreateTransport).toHaveBeenCalledWith({
      auth: { pass: "smtp-key", user: "smtp-user" },
      host: "smtp-relay.brevo.com",
      port: 587,
      secure: false,
    });
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "dofek@dofek.fit",
        subject: "Your Dofek export is ready",
        to: "user@example.com",
      }),
    );
    expect(mockSendMail.mock.calls[0]?.[0].text).toContain("https://example.test/export");
    expect(mockSendMail.mock.calls[0]?.[0].text).toContain("May 3, 2026");
  });
});
