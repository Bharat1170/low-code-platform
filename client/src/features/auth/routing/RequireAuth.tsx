import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/useAuth.ts";
import { AuthLoading } from "../components/AuthLoading.tsx";

/*
 * UX gate only: the backend still authorizes every request. While the
 * session is being restored nothing protected is rendered, so there is no
 * flash of the app or of the login page.
 */
export function RequireAuth() {
  const { isLoading, isAuthenticated } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <AuthLoading />;
  }

  if (!isAuthenticated) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  return <Outlet />;
}
