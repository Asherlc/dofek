import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSendPlainTextEmail = vi.fn().mockResolvedValue(undefined);

vi.mock("./email.ts", () => ({
  sendPlainTextEmail: (input: unknown) => mockSendPlainTextEmail(input),
}));

async function loadEmailModule() {
  vi.resetModules();
  return import("./export-email.ts");
}

describe("export email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendPlainTextEmail.mockResolvedValue(undefined);
  });

  it("sends an export ready email with the signed export URL", async () => {
    const { sendExportReadyEmail } = await loadEmailModule();

    await sendExportReadyEmail({
      downloadUrl: "https://example.test/export",
      expiresAt: new Date("2026-05-03T12:00:00.000Z"),
      toEmail: "user@example.com",
    });

    expect(mockSendPlainTextEmail).toHaveBeenCalledWith({
      subject: "Your Dofek export is ready",
      text: expect.stringContaining("https://example.test/export"),
      toEmail: "user@example.com",
    });
    expect(mockSendPlainTextEmail.mock.calls[0]?.[0].text).toContain("May 3, 2026");
  });
});
