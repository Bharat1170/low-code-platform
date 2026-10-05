import type { Request, Response } from "express";

import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from "../validators/auth.validator.js";

import { changeUserPassword } from "../services/password.service.js";

import {
  requestPasswordReset,
  resetPassword as resetUserPassword,
} from "../services/password-reset.service.js";

import {
  getCurrentUser,
  loginUser,
  registerUser,
  resendVerificationEmail,
  verifyUserEmail,
} from "../services/auth.service.js";


import {
  getRefreshTokenFromRequest,
} from "../utils/refresh-token.util.js";


import {
  listUserSessions,
  logoutSession,
  refreshLoginSession,
  revokeAllUserSessions,
  revokeUserSession,
} from "../services/session.service.js";

import { getAuthContext } from "../middleware/auth.middleware.js";

import { sessionIdParamSchema } from "../validators/session.validator.js";

import { sendSuccess } from "../utils/response.js";

import {
  clearRefreshTokenCookie,
  setRefreshTokenCookie,
} from "../utils/auth-cookie.util.js";

// Matches the maxlength of the audit log userAgent field.
const MAX_USER_AGENT_LENGTH = 1000;

const getRequestContext = (req: Request) => ({
  ipAddress: req.ip ?? "unknown",
  userAgent: (req.get("user-agent") ?? "unknown").slice(
    0,
    MAX_USER_AGENT_LENGTH,
  ),
});

export const register = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const input = registerSchema.parse(req.body);

  const result = await registerUser(input, getRequestContext(req));

  res.status(201).json({
    success: true,
    message:
      "Registration successful. Please check your email to verify your account.",
    data: result,
  });
};

export const verifyEmail = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { token } = verifyEmailSchema.parse(req.query);

  await verifyUserEmail(token);

  res.status(200).json({
    success: true,
    message: "Email verified successfully",
  });
};

export const resendVerification = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const input = resendVerificationSchema.parse(req.body);

  await resendVerificationEmail(input);

  res.status(200).json({
    success: true,
    message:
      "If the account exists and requires verification, a verification email has been sent.",
  });
};

export const login = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const input = loginSchema.parse(req.body);

  const result = await loginUser(input, {
    ipAddress: req.ip ?? "unknown",
    userAgent: req.get("user-agent") ?? "unknown",
  });

  setRefreshTokenCookie(
    res,
    result.refreshToken,
  );

  res.status(200).json({
    success: true,
    message: "Login successful",
    data: {
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
      user: result.user,
    },
  });
};

export const refresh = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const refreshToken =
    getRefreshTokenFromRequest(req);

  if (!refreshToken) {
    res.status(401).json({
      success: false,
      error: {
        code: "UNAUTHORIZED",
        message: "Refresh token is required",
        fields: {},
      },
    });

    return;
  }

  const result =
    await refreshLoginSession(refreshToken);

  setRefreshTokenCookie(
    res,
    result.refreshToken,
  );

  res.status(200).json({
    success: true,
    message: "Token refreshed successfully",
    data: {
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
    },
  });
};

export const logout = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const refreshToken =
    getRefreshTokenFromRequest(req);

  if (refreshToken) {
    await logoutSession(refreshToken, {
      ipAddress: req.ip ?? "unknown",
      userAgent:
        req.get("user-agent") ?? "unknown",
    });
  }

  clearRefreshTokenCookie(res);

  res.status(200).json({
    success: true,
    message: "Logout successful",
  });
};

export const listSessions = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const sessions = await listUserSessions(auth);

  sendSuccess(
    res,
    200,
    "Sessions retrieved successfully",
    { sessions },
  );
};

export const revokeSessionById = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const { sessionId } = sessionIdParamSchema.parse(
    req.params,
  );

  const result = await revokeUserSession(
    auth,
    sessionId,
    getRequestContext(req),
  );

  if (result.revokedCurrentSession) {
    clearRefreshTokenCookie(res);
  }

  sendSuccess(res, 200, "Session revoked successfully");
};

export const revokeAllSessions = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const result = await revokeAllUserSessions(
    auth,
    getRequestContext(req),
  );

  // The current session is always among the revoked sessions.
  clearRefreshTokenCookie(res);

  sendSuccess(
    res,
    200,
    "All sessions revoked successfully",
    { revokedCount: result.revokedCount },
  );
};


export const forgotPassword = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const input = forgotPasswordSchema.parse(req.body);

  await requestPasswordReset(input, getRequestContext(req));

  // Identical response whether or not the account exists.
  sendSuccess(
    res,
    200,
    "If an account with that email exists, a password reset email has been sent.",
  );
};

export const resetPassword = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const input = resetPasswordSchema.parse(req.body);

  await resetUserPassword(input, getRequestContext(req));

  sendSuccess(
    res,
    200,
    "Password reset successfully. Please log in with your new password.",
  );
};

export const changePassword = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const input = changePasswordSchema.parse(req.body);

  await changeUserPassword(auth, input, getRequestContext(req));

  // Every session of this user was revoked, including the caller's.
  clearRefreshTokenCookie(res);

  sendSuccess(res, 200, "Password changed successfully", {}, {});
};

export const me = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const result = await getCurrentUser(auth);

  sendSuccess(
    res,
    200,
    "Current user retrieved successfully",
    result,
  );
};
