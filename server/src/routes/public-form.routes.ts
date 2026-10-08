import { Router } from "express";

import {
  getPublicForm,
  submitPublicForm,
} from "../controllers/public-form.controller.js";
import {
  publicFormReadRateLimit,
  publicSubmissionRateLimit,
} from "../middleware/public-rate-limit.middleware.js";

const router = Router();

/*
 * Unauthenticated share-link routes. Nothing here reads a token, a
 * session or a tenant from the request: every route is
 * rate limit -> controller, and the controller resolves the form from the
 * random publicId only.
 */
router.get("/forms/:publicId", publicFormReadRateLimit, getPublicForm);

router.post(
  "/forms/:publicId/submissions",
  publicSubmissionRateLimit,
  submitPublicForm,
);

export default router;
