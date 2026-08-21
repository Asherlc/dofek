import { S3Client } from "@aws-sdk/client-s3";

export interface R2ClientConfig {
  accessKeyId: string;
  endpoint: string;
  secretAccessKey: string;
}

export function requiredR2EnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

export function readR2ClientConfig(): R2ClientConfig {
  return {
    accessKeyId: requiredR2EnvironmentVariable("R2_ACCESS_KEY_ID"),
    endpoint: requiredR2EnvironmentVariable("R2_ENDPOINT"),
    secretAccessKey: requiredR2EnvironmentVariable("R2_SECRET_ACCESS_KEY"),
  };
}

export function createR2Client(config = readR2ClientConfig()): S3Client {
  return new S3Client({
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    endpoint: config.endpoint,
    forcePathStyle: config.endpoint.startsWith("http://"),
    region: "auto",
  });
}
