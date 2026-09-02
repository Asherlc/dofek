import { PostHog } from "posthog-node";
import { POSTHOG_API_KEY, POSTHOG_HOST } from "./posthog-config.ts";

const SERVER_DISTINCT_ID = "dofek-server";

let client: PostHog | undefined;
let initialized = false;

function isProductionDeployment(environment: string | undefined): boolean {
  return environment === "prod" || environment === "production";
}

export function initProductionPostHog(serviceName = SERVER_DISTINCT_ID): void {
  if (initialized || !isProductionDeployment(process.env.DEPLOY_ENVIRONMENT)) {
    return;
  }

  initialized = true;
  client = new PostHog(POSTHOG_API_KEY, {
    host: POSTHOG_HOST,
    enableExceptionAutocapture: true,
  });
  client.register({ service: serviceName });
}

export function getPostHogClient(): PostHog | undefined {
  return client;
}

export function capturePostHogException(
  error: unknown,
  distinctId = SERVER_DISTINCT_ID,
  additionalProperties?: Record<string, unknown>,
): void {
  if (!client) {
    return;
  }

  client.captureException(error, distinctId, additionalProperties);
}

export async function shutdownPostHog(): Promise<void> {
  if (!client) {
    return;
  }

  await client.shutdown();
}
