import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { AuthLayout } from "../components/AuthLayout.tsx";
import { LoginForm } from "../components/LoginForm.tsx";
import { useAuth } from "../context/useAuth.ts";
import { readReturnTo } from "../routing/return-to.ts";

export function LoginPage() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const returnTo = readReturnTo(location.state);

  // Already signed in (e.g. /login opened directly): go to the app.
  if (isAuthenticated) {
    return <Navigate to={returnTo} replace />;
  }

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Welcome back. Enter your details to continue."
      footer={
        <>
          Don&apos;t have an account? <Link to="/register">Create one</Link>
        </>
      }
    >
      <LoginForm onSuccess={() => navigate(returnTo, { replace: true })} />
    </AuthLayout>
  );
}
