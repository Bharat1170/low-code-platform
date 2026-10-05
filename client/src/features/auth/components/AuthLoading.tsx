import "../styles/auth.css";

export function AuthLoading() {
  return (
    <div className="auth-root">
      <div className="auth-loading" role="status" aria-live="polite">
        <span className="auth-spinner" aria-hidden="true" />
        Loading...
      </div>
    </div>
  );
}
