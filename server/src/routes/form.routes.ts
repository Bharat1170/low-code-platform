import { Router } from "express";

import {
  createForm,
  deleteForm,
  getFormById,
  getFormBySlug,
  getPublishedForm,
  listForms,
  publishForm,
  updateForm,
} from "../controllers/form.controller.js";

import {
  deleteSubmission,
  exportSubmissions,
  getSubmission,
  listSubmissions,
  submitForm,
} from "../controllers/form-submission.controller.js";
import { PERMISSIONS } from "../constants/permissions.js";
import { authenticate } from "../middleware/auth.middleware.js";
import {
  requireActiveAccount,
  requirePermission,
} from "../middleware/authorization.middleware.js";

const router = Router();

/*
 * Every route: authenticate -> requireActiveAccount ->
 * requirePermission(...) -> controller.
 */
router.post(
  "/",
  authenticate,
  requireActiveAccount,
  requirePermission(PERMISSIONS.FORM_CREATE),
  createForm,
);

router.get(
  "/",
  authenticate,
  requireActiveAccount,
  requirePermission(PERMISSIONS.FORM_READ),
  listForms,
);

// Must stay before GET /:id, otherwise "slug" would be matched as an id.
router.get(
  "/slug/:slug",
  authenticate,
  requireActiveAccount,
  requirePermission(PERMISSIONS.FORM_READ),
  getFormBySlug,
);

router.get(
  "/:id",
  authenticate,
  requireActiveAccount,
  requirePermission(PERMISSIONS.FORM_READ),
  getFormById,
);

// The immutable published version (never the draft), for "Test User".
router.get(
  "/:id/published",
  authenticate,
  requireActiveAccount,
  requirePermission(PERMISSIONS.FORM_READ),
  getPublishedForm,
);

router.patch(
  "/:id",
  authenticate,
  requireActiveAccount,
  requirePermission(PERMISSIONS.FORM_UPDATE),
  updateForm,
);

router.post(
  "/:id/publish",
  authenticate,
  requireActiveAccount,
  requirePermission(PERMISSIONS.FORM_PUBLISH),
  publishForm,
);

router.get(
  "/:id/submissions",
  authenticate,
  requireActiveAccount,
  requirePermission(PERMISSIONS.SUBMISSION_READ),
  listSubmissions,
);

// Must stay before /:id/submissions/:submissionId ("export" is not an id).
router.get(
  "/:id/submissions/export",
  authenticate,
  requireActiveAccount,
  requirePermission(PERMISSIONS.SUBMISSION_READ),
  exportSubmissions,
);

router.get(
  "/:id/submissions/:submissionId",
  authenticate,
  requireActiveAccount,
  requirePermission(PERMISSIONS.SUBMISSION_READ),
  getSubmission,
);

router.delete(
  "/:id/submissions/:submissionId",
  authenticate,
  requireActiveAccount,
  requirePermission(PERMISSIONS.SUBMISSION_DELETE),
  deleteSubmission,
);

// Submits data against the form's CURRENT published version.
router.post(
  "/:id/submissions",
  authenticate,
  requireActiveAccount,
  requirePermission(PERMISSIONS.SUBMISSION_CREATE),
  submitForm,
);

router.delete(
  "/:id",
  authenticate,
  requireActiveAccount,
  requirePermission(PERMISSIONS.FORM_DELETE),
  deleteForm,
);

export default router;
