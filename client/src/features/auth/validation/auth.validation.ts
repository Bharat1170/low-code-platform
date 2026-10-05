import type {
  FieldErrors,
  LoginRequest,
  RegisterRequest,
} from "../types/auth.types.ts";

/*
 * Client-side checks that mirror the backend zod schemas
 * (server/src/validators/auth.validator.ts) so users get instant feedback.
 * The server remains authoritative.
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const validateEmail = (value: string): string | undefined => {
  const email = value.trim();

  if (email === "") return "Email is required";
  if (email.length > 320) return "Email must not exceed 320 characters";
  if (!EMAIL_PATTERN.test(email)) return "Enter a valid email address";
  return undefined;
};

const validateName = (
  value: string,
  label: string,
  min: number,
  max: number,
): string | undefined => {
  const trimmed = value.trim();

  if (trimmed === "") return `${label} is required`;
  if (trimmed.length < min) {
    return `${label} must be at least ${min} characters`;
  }
  if (trimmed.length > max) {
    return `${label} must not exceed ${max} characters`;
  }
  return undefined;
};

export type LoginField = keyof LoginRequest;
export type RegisterField = keyof RegisterRequest;

export const validateLogin = (
  values: LoginRequest,
): FieldErrors<LoginField> => {
  const errors: FieldErrors<LoginField> = {};

  const email = validateEmail(values.email);
  if (email) errors.email = email;

  if (values.password === "") {
    errors.password = "Password is required";
  } else if (values.password.length > PASSWORD_MAX_LENGTH) {
    errors.password = `Password must not exceed ${PASSWORD_MAX_LENGTH} characters`;
  }

  return errors;
};

export const validateRegister = (
  values: RegisterRequest,
): FieldErrors<RegisterField> => {
  const errors: FieldErrors<RegisterField> = {};

  const firstName = validateName(values.firstName, "First name", 1, 100);
  if (firstName) errors.firstName = firstName;

  const lastName = validateName(values.lastName, "Last name", 1, 100);
  if (lastName) errors.lastName = lastName;

  const email = validateEmail(values.email);
  if (email) errors.email = email;

  if (values.password === "") {
    errors.password = "Password is required";
  } else if (values.password.length < PASSWORD_MIN_LENGTH) {
    errors.password = `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  } else if (values.password.length > PASSWORD_MAX_LENGTH) {
    errors.password = `Password must not exceed ${PASSWORD_MAX_LENGTH} characters`;
  }

  const organizationName = validateName(
    values.organizationName,
    "Organization name",
    2,
    150,
  );
  if (organizationName) errors.organizationName = organizationName;

  return errors;
};
