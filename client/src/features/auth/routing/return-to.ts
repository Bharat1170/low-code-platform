/*
 * Where to go after signing in. Only same-app paths are accepted, so a
 * crafted link cannot redirect users to another site. The path keeps its
 * query string, which preserves ?formId=<id>.
 */
export const DEFAULT_RETURN_TO = "/";

export const readReturnTo = (state: unknown): string => {
  const candidate =
    typeof state === "object" && state !== null && "from" in state
      ? (state as { from?: unknown }).from
      : undefined;

  if (
    typeof candidate === "string" &&
    candidate.startsWith("/") &&
    !candidate.startsWith("//") &&
    !candidate.startsWith("/\\") &&
    !candidate.startsWith("/login") &&
    !candidate.startsWith("/register")
  ) {
    return candidate;
  }

  return DEFAULT_RETURN_TO;
};
