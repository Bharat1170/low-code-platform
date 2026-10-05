import { z } from "zod";

/*
 * Password policy shared by registration and password reset.
 */
export const passwordPolicySchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must not exceed 128 characters");

export const registerSchema = z
  .object({
    firstName: z
      .string()
      .trim()
      .min(1, "First name is required")
      .max(100, "First name must not exceed 100 characters"),

    lastName: z
      .string()
      .trim()
      .min(1, "Last name is required")
      .max(100, "Last name must not exceed 100 characters"),

    email: z
      .string()
      .trim()
      .email("Invalid email address")
      .max(320, "Email must not exceed 320 characters")
      .transform((value) => value.toLowerCase()),

    password: passwordPolicySchema,

    organizationName: z
      .string()
      .trim()
      .min(2, "Organization name must be at least 2 characters")
      .max(150, "Organization name must not exceed 150 characters"),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;


export const verifyEmailSchema = z
  .object({
    token: z
      .string()
      .trim()
      .regex(
        /^[a-fA-F0-9]{64}$/,
        "Invalid verification token",
      ),
  })
  .strict();

export type VerifyEmailInput = z.infer<
  typeof verifyEmailSchema
>;

export const resendVerificationSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email("Invalid email address")
      .max(320, "Email must not exceed 320 characters")
      .transform((value) => value.toLowerCase()),

    organizationId: z
      .string()
      .trim()
      .regex(
        /^[a-f\d]{24}$/i,
        "Invalid organization ID",
      ),
  })
  .strict();

export type ResendVerificationInput = z.infer<
  typeof resendVerificationSchema
>;


export const loginSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email("Invalid email address")
      .max(320, "Email must not exceed 320 characters")
      .transform((value) => value.toLowerCase()),

    password: z
      .string()
      .min(1, "Password is required")
      .max(128, "Password must not exceed 128 characters"),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email("Invalid email address")
      .max(320, "Email must not exceed 320 characters")
      .transform((value) => value.toLowerCase()),
  })
  .strict();

export type ForgotPasswordInput = z.infer<
  typeof forgotPasswordSchema
>;

export const resetPasswordSchema = z
  .object({
    token: z
      .string()
      .trim()
      .regex(
        /^[a-fA-F0-9]{64}$/,
        "Invalid reset token",
      ),

    newPassword: passwordPolicySchema,
  })
  .strict();

export type ResetPasswordInput = z.infer<
  typeof resetPasswordSchema
>;

export const changePasswordSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1, "Current password is required")
      .max(128, "Password must not exceed 128 characters"),

    newPassword: passwordPolicySchema,
  })
  .strict();

export type ChangePasswordInput = z.infer<
  typeof changePasswordSchema
>;
