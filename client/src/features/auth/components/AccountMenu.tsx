import { useAuth } from "../context/useAuth.ts";

/* Signed-in user label and Sign out, shown in the builder header. */
export function AccountMenu() {
  const { user, organization, logout, isLoggingOut } = useAuth();

  return (
    <div className="auth-account">
      {user && (
        <span className="auth-account-name" title={organization?.name}>
          {user.firstName} {user.lastName}
        </span>
      )}
      <button
        type="button"
        className="fb-button"
        onClick={() => void logout()}
        disabled={isLoggingOut}
        aria-busy={isLoggingOut}
      >
        {isLoggingOut ? "Signing out..." : "Sign out"}
      </button>
    </div>
  );
}
