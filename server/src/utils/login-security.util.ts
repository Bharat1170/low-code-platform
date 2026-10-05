import { AUTH_CONSTANTS } from "../constants/auth.constants.js";

export const getProgressiveLoginDelayMs = (
  failedAttemptCount: number,
): number => {
  if (failedAttemptCount < 3) {
    return 0;
  }

  const exponent = failedAttemptCount - 3;

  const calculatedDelay =
    AUTH_CONSTANTS.LOGIN_PROGRESSIVE_DELAY_BASE_MS *
    2 ** exponent;

  return Math.min(
    calculatedDelay,
    AUTH_CONSTANTS.LOGIN_PROGRESSIVE_DELAY_MAX_MS,
  );
};