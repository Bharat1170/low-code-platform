import mongoose, { Schema, Document } from "mongoose";

export const FORM_STATUSES = [
  "DRAFT",
  "PUBLISHED",
  "ARCHIVED",
] as const;

export type FormStatus = (typeof FORM_STATUSES)[number];

export interface IForm extends Document {
  organizationId: mongoose.Types.ObjectId;
  projectId: mongoose.Types.ObjectId;
  name: string;
  description: string;
  slug: string;
  status: FormStatus;
  // Random share-link identifier, assigned server-side the first time the
  // form is published. Never client-writable.
  publicId?: string;
  // FormVersion does not exist yet; these are plain ObjectId fields.
  // The single mutable builder draft (validated FormSchema, plain JSON).
  // Autosave overwrites it in place; versions are a later step.
  draftSchema?: Record<string, unknown>;
  currentDraftVersionId?: mongoose.Types.ObjectId;
  publishedVersionId?: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const formSchema = new Schema<IForm>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },

    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
    },

    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },

    slug: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 150,
    },

    status: {
      type: String,
      enum: FORM_STATUSES,
      required: true,
    },

    publicId: {
      type: String,
      trim: true,
      minlength: 24,
      maxlength: 24,
      match: /^[A-Za-z0-9_-]{24}$/,
    },

    draftSchema: {
      type: Schema.Types.Mixed,
    },

    currentDraftVersionId: {
      type: Schema.Types.ObjectId,
    },

    publishedVersionId: {
      type: Schema.Types.ObjectId,
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
    // The draft schema contains meaningful empty objects (for example
    // `validation: {}`); they must round-trip unchanged.
    minimize: false,
  },
);

// Slug uniqueness is scoped per organization, never global.
formSchema.index(
  {
    organizationId: 1,
    slug: 1,
  },
  {
    unique: true,
  },
);

// A publicId is globally unique (it is looked up without a tenant) but
// only forms that have been published have one, hence sparse.
formSchema.index({ publicId: 1 }, { unique: true, sparse: true });

// Query pattern: forms of a project within an organization.
formSchema.index({
  organizationId: 1,
  projectId: 1,
});

export const Form = mongoose.model<IForm>("Form", formSchema);
