import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ApiError,
  setAuthFailureHandler,
} from "../../../lib/http.ts";
import * as authApi from "../api/auth.api.ts";
import type {
  AuthOrganization,
  AuthStatus,
  AuthUser,
  LoginRequest,
} from "../types/auth.types.ts";
import { AuthContext, type AuthContextValue } from "./auth-context.ts";

interface Session {
  status: AuthStatus;
  user: AuthUser | null;
  organization: AuthOrganization | null;
}

const LOADING: Session = { status: "loading", user: null, organization: null };
const SIGNED_OUT: Session = {
  status: "unauthenticated",
  user: null,
  organization: null,
};

/*
 * The single source of truth for authentication. On start it tries to
 * restore the session from the httpOnly refresh cookie (POST /auth/refresh
 * then GET /auth/me). The access token itself stays in lib/http's memory.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>(LOADING);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loggingOutRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    // A refresh the server rejects means the session is over.
    const unsubscribe = setAuthFailureHandler(() => {
      setSession(SIGNED_OUT);
    });

    const restore = async () => {
      try {
        // Concurrent refreshes share one request (see lib/http), so a
        // StrictMode double-mount cannot rotate the token twice.
        await authApi.refresh();
        const current = await authApi.getCurrentUser();

        if (!cancelled) {
          setSession({
            status: "authenticated",
            user: current.user,
            organization: current.organization,
          });
        }
      } catch (caught) {
        if (cancelled) return;

        setSession(SIGNED_OUT);

        // 401 just means "not signed in"; only surface real failures.
        if (!(caught instanceof ApiError && caught.status === 401)) {
          setError("We couldn't reach the server. Please try again.");
        }
      }
    };

    void restore();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const login = useCallback(async (request: LoginRequest) => {
    const user = await authApi.login(request);

    let organization: AuthOrganization | null = null;
    try {
      organization = (await authApi.getCurrentUser()).organization;
    } catch {
      // The sign-in itself succeeded; the organization name is cosmetic.
    }

    setError(null);
    setSession({ status: "authenticated", user, organization });
  }, []);

  const logout = useCallback(async () => {
    // A second click before React re-renders must not send a second request.
    if (loggingOutRef.current) return;
    loggingOutRef.current = true;
    setIsLoggingOut(true);

    try {
      await authApi.logout();
    } catch {
      // Signing out locally is always correct, even if the server is down.
    } finally {
      setSession(SIGNED_OUT);
      setIsLoggingOut(false);
      loggingOutRef.current = false;
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status: session.status,
      isAuthenticated: session.status === "authenticated",
      isLoading: session.status === "loading",
      isLoggingOut,
      user: session.user,
      organization: session.organization,
      error,
      login,
      logout,
    }),
    [session, isLoggingOut, error, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
