interface PlainTextEmailInput {
  subject: string;
  text: string;
  toEmail: string;
}

interface BrevoEmailConfig {
  apiKey: string;
  fromEmail: string;
}

const BREVO_EMAIL_URL = "https://api.brevo.com/v3/smtp/email";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

function readBrevoConfig(): BrevoEmailConfig {
  return {
    apiKey: requiredEnv("BREVO_API_KEY"),
    fromEmail: requiredEnv("EXPORT_EMAIL_FROM"),
  };
}

export async function sendPlainTextEmail(input: PlainTextEmailInput): Promise<void> {
  const config = readBrevoConfig();
  const response = await fetch(BREVO_EMAIL_URL, {
    body: JSON.stringify({
      sender: { email: config.fromEmail },
      subject: input.subject,
      textContent: input.text,
      to: [{ email: input.toEmail }],
    }),
    headers: {
      accept: "application/json",
      "api-key": config.apiKey,
      "content-type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    const status = `Brevo email request failed with status ${response.status}`;
    let body = "";
    try {
      body = (await response.text()).trim();
    } catch {
      throw new Error(status);
    }
    throw new Error(body.length > 0 ? `${status}: ${body}` : status);
  }
}
