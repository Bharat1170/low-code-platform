import { useState, type FormEvent } from "react";
import { ApiError } from "../../../lib/http.ts";
import { register } from "../api/auth.api.ts";
import type { FieldErrors, RegisterRequest } from "../types/auth.types.ts";
import {
  PASSWORD_MIN_LENGTH,
  validateRegister,
  type RegisterField,
} from "../validation/auth.validation.ts";
import { AuthField } from "./AuthField.tsx";
import { describeAuthError } from "./authErrors.ts";

interface RegisterFormProps {
  /* Called with the registered email once the server accepted it. */
  onRegistered: (email: string) => void;
}

const EMPTY: RegisterRequest = {
  firstName: "",
  lastName: "",
  email: "",
  password: "",
  organizationName: "",
};

export function RegisterForm({ onRegistered }: RegisterFormProps) {
  const [values, setValues] = useState<RegisterRequest>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors<RegisterField>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (key: RegisterField) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;

    const found = validateRegister(values);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);

    try {
      const result = await register(values);
      onRegistered(result.email);
    } catch (error) {
      setFormError(describeAuthError(error, "register"));
      if (error instanceof ApiError && error.status === 400) {
        const next: FieldErrors<RegisterField> = {};
        for (const key of Object.keys(EMPTY) as RegisterField[]) {
          if (error.fields[key]) next[key] = error.fields[key];
        }
        setErrors(next);
      }
      setSubmitting(false);
    }
  };

  return (
    <form
      className="auth-form"
      onSubmit={handleSubmit}
      noValidate
      aria-busy={submitting}
    >
      {formError && (
        <p className="auth-alert" role="alert">
          {formError}
        </p>
      )}
      <div className="auth-row">
        <AuthField
          label="First name"
          autoComplete="given-name"
          value={values.firstName}
          onChange={set("firstName")}
          error={errors.firstName}
        />
        <AuthField
          label="Last name"
          autoComplete="family-name"
          value={values.lastName}
          onChange={set("lastName")}
          error={errors.lastName}
        />
      </div>
      <AuthField
        label="Email"
        type="email"
        autoComplete="email"
        value={values.email}
        onChange={set("email")}
        error={errors.email}
      />
      <AuthField
        label="Password"
        type="password"
        autoComplete="new-password"
        value={values.password}
        onChange={set("password")}
        error={errors.password}
      />
      <p className="auth-hint">At least {PASSWORD_MIN_LENGTH} characters.</p>
      <AuthField
        label="Organization name"
        autoComplete="organization"
        value={values.organizationName}
        onChange={set("organizationName")}
        error={errors.organizationName}
      />
      <button type="submit" className="auth-submit" disabled={submitting}>
        {submitting ? "Registering..." : "Create account"}
      </button>
    </form>
  );
}
