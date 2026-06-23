import { formatDateMedium } from "@dofek/format/format";
import { sendPlainTextEmail } from "./email.ts";

interface ExportReadyEmailInput {
  downloadUrl: string;
  expiresAt: Date;
  toEmail: string;
}

export async function sendExportReadyEmail(input: ExportReadyEmailInput): Promise<void> {
  const expiresAt = formatDateMedium(input.expiresAt);

  await sendPlainTextEmail({
    subject: "Your Dofek export is ready",
    text: [
      "Your Dofek data export is ready.",
      "",
      `Download it here: ${input.downloadUrl}`,
      "",
      `This link and file expire on ${expiresAt}.`,
    ].join("\n"),
    toEmail: input.toEmail,
  });
}
