import mongoose, { Schema, Document } from "mongoose";
import type { SubmissionData } from "../validators/form-submission.validator.js";

/*
 * One submission of a published form (8.17.15). All forms share this one
 * collection; nothing is created per form.
 *
 * A submission is bound to the exact immutable FormVersion it was
 * validated against (formVersionId + version), never to the form's
 * mutable draft, so later publishes cannot change what it refers to.
 * organizationId, formId, formVersionId, version and submittedBy are only
 * ever set by the server, never taken from a request.
 *
 * `data` holds field values keyed by the stable field id (strings,
 * booleans and lists of strings only, validated before saving).
 */
export interface IFormSubmission extends Document {
  organizationId: mongoose.Types.ObjectId;
  formId: mongoose.Types.ObjectId;
  formVersionId: mongoose.Types.ObjectId;
  version: number;
  data: SubmissionData;
  /* The signed-in submitter; null for an anonymous public submission. */
  submittedBy: mongoose.Types.ObjectId | null;
  submittedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const formSubmissionSchema = new Schema<IFormSubmission>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },

    formId: {
      type: Schema.Types.ObjectId,
      ref: "Form",
      required: true,
    },

    formVersionId: {
      type: Schema.Types.ObjectId,
      ref: "FormVersion",
      required: true,
    },

    version: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: "version must be an integer",
      },
    },

    data: {
      type: Schema.Types.Mixed,
      required: true,
    },

    submittedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    submittedAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
    collection: "form_submissions",
    // An empty data object is a valid submission (all fields optional).
    minimize: false,
  },
);

// Future per-form and per-version listings, newest first. Deliberately no
// unique index: many submissions per form (and per user) are valid.
formSubmissionSchema.index({ organizationId: 1, formId: 1, submittedAt: -1 });
formSubmissionSchema.index({
  organizationId: 1,
  formVersionId: 1,
  submittedAt: -1,
});
// Organization-wide recent submissions.
formSubmissionSchema.index({ organizationId: 1, submittedAt: -1 });

export const FormSubmission = mongoose.model<IFormSubmission>(
  "FormSubmission",
  formSubmissionSchema,
);
