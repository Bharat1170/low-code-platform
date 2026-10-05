import { createContext } from "react";
import type {
  AuthOrganization,
  AuthStatus,
  AuthUser,
  LoginRequest,
} from "../types/auth.types.ts";

export interface AuthContextValue {
  status: AuthStatus;
  isAuthenticated: boolean;
  isLoading: boolean;
  isLoggingOut: boolean;
  user: AuthUser | null;
  organization: AuthOrganization | null;
  /* Set when restoring the session failed for a non-auth reason (e.g. offline). */
  error: string | null;
  /* Rejects with an ApiError on failure; the form decides how to show it. */
  login: (request: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
