import { useState } from "react";
import { Link } from "react-router-dom";
import { AuthLayout } from "../components/AuthLayout.tsx";
import { RegisterForm } from "../components/RegisterForm.tsx";

export function RegisterPage() {
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);

  if (registeredEmail !== null) {
    return (
      <AuthLayout
        title="Check your email"
        subtitle="Your account has been created."
        footer={<Link to="/login">Back to sign in</Link>}
      >
        <div className="auth-success" role="status">
          <p>
            Registration successful. Please verify your email before signing
            in. We sent a verification link to{" "}
            <strong>{registeredEmail}</strong>.
          </p>
        </div>
        <Link className="auth-submit auth-link-button" to="/login">
          Go to sign in
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Set up your organization and start building forms."
      footer={
        <>
          Already have an account? <Link to="/login">Sign in</Link>
        </>
      }
    >
      <RegisterForm onRegistered={setRegisteredEmail} />
    </AuthLayout>
  );
}
