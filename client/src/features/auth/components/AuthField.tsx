import { useId, useState, type InputHTMLAttributes } from "react";

interface AuthFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "onChange"> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}

/* Labelled input with an accessible inline error (and password toggle). */
export function AuthField({
  label,
  value,
  onChange,
  error,
  type = "text",
  ...rest
}: AuthFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === "password";

  return (
    <div className="auth-field">
      <label className="auth-label" htmlFor={id}>
        {label}
      </label>
      <div className="auth-input-wrap">
        <input
          {...rest}
          id={id}
          className="auth-input"
          type={isPassword && revealed ? "text" : type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        {isPassword && (
          <button
            type="button"
            className="auth-reveal"
            aria-pressed={revealed}
            aria-label={revealed ? "Hide password" : "Show password"}
            onClick={() => setRevealed((current) => !current)}
          >
            {revealed ? "Hide" : "Show"}
          </button>
        )}
      </div>
      {error && (
        <p id={errorId} className="auth-error">
          {error}
        </p>
      )}
    </div>
  );
}
