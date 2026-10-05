import { Outlet } from "react-router-dom";
import { AuthLoading } from "../components/AuthLoading.tsx";
import { useAuth } from "../context/useAuth.ts";

/* Holds the public pages back until the session check has finished. */
export function PublicOnly() {
  const { isLoading } = useAuth();

  return isLoading ? <AuthLoading /> : <Outlet />;
}
