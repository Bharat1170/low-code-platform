import { useContext } from "react";
import { AuthContext, type AuthContextValue } from "./auth-context.ts";

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }

  return context;
};
