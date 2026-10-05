import type {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";

import type { Permission } from "../constants/permissions.js";
import {
  loadActiveAccount,
  resolvePermissions,
} from "../services/authorization.service.js";
import { AppError } from "../utils/errors.js";
import { getAuthContext } from "./auth.middleware.js";

/*
 * Authorization middleware. Always run after `authenticate`:
 *
 *   authenticate -> requireActiveAccount -> requirePermission(...) -> controller
 *
 * Express 5 forwards rejected promises to the error handler, so these
 * handlers simply throw AppError.
 */

/*
 * Requires the authenticated user AND organization to still be ACTIVE.
 * Sets req.account from database state.
 */
export const requireActiveAccount: RequestHandler = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  req.account = await loadActiveAccount(getAuthContext(req));

  next();
};

/*
 * Requires ALL of the given permissions.
 *
 * Permissions are re-derived from the database on every request, from
 * roles of the authenticated organization only. Nothing in the request
 * body, query, params or headers can grant or influence them. It also
 * performs the active-account check, so it cannot be used without it.
 */
export const requirePermission = (
  ...required: Permission[]
): RequestHandler => {
  if (required.length === 0) {
    // A guard that requires nothing would silently allow everyone.
    throw new Error(
      "requirePermission needs at least one permission",
    );
  }

  return async (
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const account =
      req.account ?? (await loadActiveAccount(getAuthContext(req)));

    const granted = await resolvePermissions(account);

    if (!required.every((permission) => granted.has(permission))) {
      // Do not reveal which permission is missing.
      throw new AppError(
        403,
        "FORBIDDEN",
        "You do not have permission to perform this action",
      );
    }

    req.account = account;
    req.permissions = granted;

    next();
  };
};
