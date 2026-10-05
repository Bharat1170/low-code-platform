import mongoose, { Schema, Document } from "mongoose";

export interface IProject extends Document {
  organizationId: mongoose.Types.ObjectId;
  name: string;
  description: string;
  slug: string;
  // Allowed business statuses are defined by the validator/business layer.
  status: string;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const projectSchema = new Schema<IProject>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
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
      required: true,
      trim: true,
      uppercase: true,
      minlength: 1,
      maxlength: 50,
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

// Slug uniqueness is scoped per organization, never global.
projectSchema.index(
  {
    organizationId: 1,
    slug: 1,
  },
  {
    unique: true,
  },
);

export const Project = mongoose.model<IProject>("Project", projectSchema);
