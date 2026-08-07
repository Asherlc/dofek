import nodemailer from "nodemailer";

interface PlainTextEmailInput {
  subject: string;
  text: string;
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

export async function sendPlainTextEmail(input: PlainTextEmailInput): Promise<void> {
  const config = readBrevoConfig();
  const transporter = nodemailer.createTransport({
    auth: { pass: config.smtpKey, user: config.smtpUser },
    host: "smtp-relay.brevo.com",
    port: 587,
    secure: false,
  });

  await transporter.sendMail({
    from: config.fromEmail,
    subject: input.subject,
    text: input.text,
    to: input.toEmail,
  });
}
