import { ApiError } from "../../../lib/http.ts";

/* User-facing text for a failed auth request. Never shows raw server detail. */
export const describeAuthError = (
  error: unknown,
  action: "login" | "register",
): string => {
  if (!(error instanceof ApiError)) {
    return "Something went wrong. Please try again.";
  }

  switch (error.status) {
    case 0:
      return error.code === "TIMEOUT"
        ? "The request timed out. Please try again."
        : "We couldn't reach the server. Check your connection and try again.";
    case 400:
      return "Please check the highlighted fields and try again.";
    case 401:
      return action === "login"
        ? "Invalid email or password."
        : "Unable to complete registration.";
    case 403:
      return "This account can't sign in right now. Contact your administrator.";
    case 409:
      return "An account with these details already exists. Try signing in instead.";
    case 429:
      return "Too many attempts. Please wait a moment and try again.";
    default:
      return error.status >= 500
        ? "The server ran into a problem. Please try again shortly."
        : "Something went wrong. Please try again.";
  }
};
