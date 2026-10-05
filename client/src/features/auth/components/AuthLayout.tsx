import type { ReactNode } from "react";
import "../styles/auth.css";

interface AuthLayoutProps {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}

/* Shared shell for the sign-in and registration screens. */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: AuthLayoutProps) {
  return (
    <div className="auth-root">
      <main className="auth-card">
        <div className="auth-brand">
          <span className="auth-logo" aria-hidden="true" />
          <span className="auth-brand-name">Low-Code Platform</span>
        </div>
        <h1 className="auth-title">{title}</h1>
        <p className="auth-subtitle">{subtitle}</p>
        {children}
      </main>
      {footer && <p className="auth-footer">{footer}</p>}
    </div>
  );
}
