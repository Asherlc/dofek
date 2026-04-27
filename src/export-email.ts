import nodemailer from "nodemailer";

interface ExportReadyEmailInput {
  downloadUrl: string;
  expiresAt: Date;
  toEmail: string;
}

interface BrevoSmtpConfig {
  fromEmail: string;
  smtpKey: string;
  smtpUser: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

function readBrevoConfig(): BrevoSmtpConfig {
  return {
    fromEmail: requiredEnv("EXPORT_EMAIL_FROM"),
    smtpKey: requiredEnv("BREVO_SMTP_KEY"),
    smtpUser: requiredEnv("BREVO_SMTP_USER"),
  };
}

export async function sendExportReadyEmail(input: ExportReadyEmailInput): Promise<void> {
  const config = readBrevoConfig();
  const transporter = nodemailer.createTransport({
    auth: { pass: config.smtpKey, user: config.smtpUser },
    host: "smtp-relay.brevo.com",
    port: 587,
    secure: false,
  });
  const expiresAt = input.expiresAt.toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  await transporter.sendMail({
    from: config.fromEmail,
    subject: "Your Dofek export is ready",
    text: [
      "Your Dofek data export is ready.",
      "",
      `Download it here: ${input.downloadUrl}`,
      "",
      `This link and file expire on ${expiresAt}.`,
    ].join("\n"),
    to: input.toEmail,
  });
}
