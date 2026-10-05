import mongoose, { Schema, Document } from "mongoose";

export const FORM_VERSION_STATUSES = ["PUBLISHED"] as const;

export type FormVersionStatus = (typeof FORM_VERSION_STATUSES)[number];

/*
 * An immutable snapshot of a form schema, created only by publishing.
 * `schemaSnapshot` is a deep copy of the validated draft at publish time, never a
 * reference to the Form's mutable draft.
 */
export interface IFormVersion extends Document {
  organizationId: mongoose.Types.ObjectId;
  formId: mongoose.Types.ObjectId;
  version: number;
  status: FormVersionStatus;
  schemaSnapshot: Record<string, unknown>;
  settings: Record<string, unknown>;
  createdBy: mongoose.Types.ObjectId;
  publishedBy: mongoose.Types.ObjectId;
  publishedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const formVersionSchema = new Schema<IFormVersion>(
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

    version: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: "version must be an integer",
      },
    },

    status: {
      type: String,
      enum: FORM_VERSION_STATUSES,
      required: true,
    },

    schemaSnapshot: {
      type: Schema.Types.Mixed,
      required: true,
    },

    settings: {
      type: Schema.Types.Mixed,
      default: {},
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    publishedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    publishedAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
    // Empty objects in the schema (for example `validation: {}`) are
    // meaningful and must be stored unchanged.
    minimize: false,
  },
);

// Version numbers are unique per form; this is also the lookup pattern.
formVersionSchema.index(
  {
    organizationId: 1,
    formId: 1,
    version: 1,
  },
  {
    unique: true,
  },
);

/*
 * Immutability. A version can be inserted once and never changed or
 * removed through the model: every update/replace/delete path throws.
 * (Raw collection access is outside the model and is not part of the
 * application.)
 */
const immutable = (): never => {
  throw new Error("Form versions are immutable");
};

formVersionSchema.pre("save", function () {
  if (!this.isNew) {
    immutable();
  }
});

formVersionSchema.pre(
  [
    "updateOne",
    "updateMany",
    "findOneAndUpdate",
    "findOneAndReplace",
    "replaceOne",
    "deleteOne",
    "deleteMany",
    "findOneAndDelete",
  ],
  immutable,
);

formVersionSchema.pre("deleteOne", { document: true, query: false }, immutable);

export const FormVersion = mongoose.model<IFormVersion>(
  "FormVersion",
  formVersionSchema,
);
