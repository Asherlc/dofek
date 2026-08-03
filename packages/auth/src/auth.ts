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
  password: z.boolean().optional(),
});

export type ConfiguredProviders = z.infer<typeof ConfiguredProvidersSchema>;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_REQUIREMENT_TEXT = `Use ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters.`;

const EmailAddressSchema = z.string().trim().email();

export function getEmailValidationError(email: string): string | null {
  if (email.trim().length === 0) {
    return "Enter your email address.";
  }
  return EmailAddressSchema.safeParse(email).success ? null : "Enter a valid email address.";
}

export function getNewPasswordValidationError(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Use no more than ${PASSWORD_MAX_LENGTH} characters.`;
  }
  return null;
}

export const PasswordRegisterRequestSchema = z.object({
  email: EmailAddressSchema,
  password: z.string(),
  name: z.string().trim().min(1).max(200).optional(),
});

export type PasswordRegisterRequest = z.infer<typeof PasswordRegisterRequestSchema>;

export const PasswordLoginRequestSchema = z.object({
  email: EmailAddressSchema,
  password: z.string(),
});

export type PasswordLoginRequest = z.infer<typeof PasswordLoginRequestSchema>;

export const PasswordResetRequestSchema = z.object({
  email: EmailAddressSchema,
});

export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;

export const PasswordResetConfirmSchema = z.object({
  password: z.string(),
  token: z.string().min(1),
});

export type PasswordResetConfirmRequest = z.infer<typeof PasswordResetConfirmSchema>;

export const SetPasswordRequestSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string(),
});

export type SetPasswordRequest = z.infer<typeof SetPasswordRequestSchema>;
