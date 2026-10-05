import mongoose, { Schema, Document } from "mongoose";

export interface IRole extends Document {
  organizationId: mongoose.Types.ObjectId;
  name:
    | "OWNER"
    | "ADMIN"
    | "BUILDER"
    | "VIEWER"
    | "SUBMISSION_MANAGER";
  description: string;
  permissions: string[];
  createdAt: Date;
  updatedAt: Date;
}

const roleSchema = new Schema<IRole>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    name: {
      type: String,
      enum: [
        "OWNER",
        "ADMIN",
        "BUILDER",
        "VIEWER",
        "SUBMISSION_MANAGER",
      ],
      required: true,
      trim: true,
    },

    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },

    permissions: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

roleSchema.index(
  {
    organizationId: 1,
    name: 1,
  },
  {
    unique: true,
  },
);

export const Role = mongoose.model<IRole>("Role", roleSchema);