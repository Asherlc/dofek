import { z } from "zod";

/** The three identity providers supported for login. */
export const IDENTITY_PROVIDER_NAMES = ["google", "apple", "authentik"] as const;

export type IdentityProviderName = (typeof IDENTITY_PROVIDER_NAMES)[number];

export const AuthUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  isAdmin: z.boolean().optional(),
});

export type AuthUser = z.infer<typeof AuthUserSchema>;

export const ConfiguredProvidersSchema = z.object({
  identity: z.array(z.enum(IDENTITY_PROVIDER_NAMES)),
  data: z.array(z.string()),
});

export type ConfiguredProviders = z.infer<typeof ConfiguredProvidersSchema>;
