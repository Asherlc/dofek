import { z } from "zod";

/** The identity providers supported for login. */
export const IDENTITY_PROVIDER_NAMES = ["google", "apple"] as const;

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
  nativeApple: z.boolean().optional(),
});

export type ConfiguredProviders = z.infer<typeof ConfiguredProvidersSchema>;
