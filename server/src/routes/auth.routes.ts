import { Router } from "express";

import {
  changePassword,
  forgotPassword,
  listSessions,
  login,
  logout,
  me,
  refresh,
  register,
  resendVerification,
  resetPassword,
  revokeAllSessions,
  revokeSessionById,
  verifyEmail,
} from "../controllers/auth.controller.js";

import { authenticate } from "../middleware/auth.middleware.js";
import { loginRateLimit } from "../middleware/login-rate-limit.middleware.js";
import {
  changePasswordRateLimit,
  forgotPasswordRateLimit,
  resetPasswordRateLimit,
} from "../middleware/password-reset-rate-limit.middleware.js";

const router = Router();

router.post("/register", register);
router.post("/login", loginRateLimit, login);
router.post("/refresh", refresh);
router.post("/logout", logout);
router.get("/verify-email", verifyEmail);
router.post("/resend-verification", resendVerification);
router.post(
  "/forgot-password",
  forgotPasswordRateLimit,
  forgotPassword,
);
router.post(
  "/reset-password",
  resetPasswordRateLimit,
  resetPassword,
);

router.post(
  "/change-password",
  authenticate,
  changePasswordRateLimit,
  changePassword,
);

router.get("/me", authenticate, me);
router.get("/sessions", authenticate, listSessions);
router.delete("/sessions", authenticate, revokeAllSessions);
router.delete(
  "/sessions/:sessionId",
  authenticate,
  revokeSessionById,
);

export default router;