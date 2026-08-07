import { z } from "zod";
import { classifyProviderAuth } from "./types.ts";

/**
 * Wraps a raw Provider plugin with derived state (connection status, auth type, etc.).
 * Providers that define `authSetup` require authentication. Connection state is
 * supplied from the user-scoped provider connection table.
 */
function isHttpsUrl(value: string): boolean {
  return value.toLowerCase().startsWith("https://");
}

export const providerTokenAuthSchema = z.object({
  label: z.string(),
  instructionsUrl: z.url().refine(isHttpsUrl, {
    message: "Token instructions URL must use HTTPS",
  }),
});

export class ProviderModel {
  readonly id: string;
  readonly name: string;
  readonly importOnly: boolean;
  readonly authType: string;
  readonly tokenAuth: { label: string; instructionsUrl: string } | null;
  readonly isConnected: boolean;
  readonly lastSyncedAt: string | null;

  constructor(
    provider: {
      id: string;
      name: string;
      importOnly?: boolean;
      authSetup?(options?: { host?: string }): unknown;
    },
    connectionSet: Set<string>,
    lastSyncMap?: Map<string, string>,
    customAuthOverrides?: Record<string, string>,
  ) {
    this.id = provider.id;
    this.name = provider.name;
    this.importOnly = provider.importOnly === true;
    this.tokenAuth = null;

    let authType = "none";
    if (this.importOnly) {
      authType = "file-import";
    } else {
      try {
        const setup = provider.authSetup?.();
        if (setup && typeof setup === "object") {
          const parsedManualToken = providerTokenAuthSchema.safeParse(
            Reflect.get(setup, "manualToken"),
          );
          if (parsedManualToken.success) {
            this.tokenAuth = parsedManualToken.data;
          }
          authType = classifyProviderAuth({
            automatedLogin: typeof Reflect.get(setup, "automatedLogin") === "function",
            oauth1: Boolean(Reflect.get(setup, "oauth1Flow")),
            manualToken: parsedManualToken.success,
            oauth:
              Boolean(Reflect.get(setup, "oauthConfig")) &&
              typeof Reflect.get(setup, "exchangeCode") === "function",
          });
        }
      } catch {
        /* credentials not configured */
      }
    }

    this.authType = customAuthOverrides?.[provider.id] ?? authType;
    const needsAuth = this.authType !== "none" && this.authType !== "file-import";
    this.isConnected = needsAuth ? connectionSet.has(provider.id) : true;
    this.lastSyncedAt = lastSyncMap?.get(provider.id) ?? null;
  }
}
