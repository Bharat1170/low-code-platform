import { Router } from "express";

import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from "../controllers/project.controller.js";

import { PERMISSIONS } from "../constants/permissions.js";
import { authenticate } from "../middleware/auth.middleware.js";
import { requirePermission } from "../middleware/authorization.middleware.js";

const router = Router();

/*
 * Every route: authenticate -> requirePermission(...) -> controller.
 * requirePermission also enforces ACTIVE user/organization.
 */
router.post(
  "/",
  authenticate,
  requirePermission(PERMISSIONS.PROJECT_CREATE),
  createProject,
);

router.get(
  "/",
  authenticate,
  requirePermission(PERMISSIONS.PROJECT_READ),
  listProjects,
);

router.get(
  "/:id",
  authenticate,
  requirePermission(PERMISSIONS.PROJECT_READ),
  getProject,
);

router.patch(
  "/:id",
  authenticate,
  requirePermission(PERMISSIONS.PROJECT_UPDATE),
  updateProject,
);

router.delete(
  "/:id",
  authenticate,
  requirePermission(PERMISSIONS.PROJECT_DELETE),
  deleteProject,
);

export default router;
