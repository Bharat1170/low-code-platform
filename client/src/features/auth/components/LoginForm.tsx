import { useState, type FormEvent } from "react";
import { ApiError } from "../../../lib/http.ts";
import { useAuth } from "../context/useAuth.ts";
import type { FieldErrors } from "../types/auth.types.ts";
import {
  validateLogin,
  type LoginField,
} from "../validation/auth.validation.ts";
import { AuthField } from "./AuthField.tsx";
import { describeAuthError } from "./authErrors.ts";

interface LoginFormProps {
  /* Called after the AuthProvider is authenticated. */
  onSuccess: () => void;
}

export function LoginForm({ onSuccess }: LoginFormProps) {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors<LoginField>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;

    const found = validateLogin({ email, password });
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);

    try {
      await login({ email, password });
      onSuccess();
    } catch (error) {
      // Wrong password and unknown email look identical on purpose.
      setFormError(describeAuthError(error, "login"));
      if (error instanceof ApiError && error.status === 400) {
        setErrors({
          email: error.fields.email,
          password: error.fields.password,
        });
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
      <AuthField
        label="Email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={setEmail}
        error={errors.email}
      />
      <AuthField
        label="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
        error={errors.password}
      />
      <button type="submit" className="auth-submit" disabled={submitting}>
        {submitting ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}
