import mongoose, { Schema, Document } from "mongoose";

export interface IUser extends Document {
  organizationId: mongoose.Types.ObjectId;
  firstName: string;
  lastName: string;
  email: string;
  passwordHash: string;
  roleIds: mongoose.Types.ObjectId[];
  status: "ACTIVE" | "SUSPENDED" | "DELETED";
  emailVerified: boolean;
  lastLoginAt?: Date;
  passwordChangedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    firstName: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 100,
    },

    lastName: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 100,
    },

    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 320,
    },

    passwordHash: {
      type: String,
      required: true,
      select: false,
    },

    roleIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "Role",
      },
    ],

    status: {
      type: String,
      enum: ["ACTIVE", "SUSPENDED", "DELETED"],
      default: "ACTIVE",
      index: true,
    },

    emailVerified: {
      type: Boolean,
      default: false,
      index: true,
    },

    passwordChangedAt: {
      type: Date,
      default: null,
    },

    lastLoginAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

/*
 * Email is globally unique (login and password reset look users up by
 * email alone). This is the only email index; do not also set `index: true`
 * on the field, or Mongoose declares two conflicting `email_1` indexes.
 */
userSchema.index(
  {
    email: 1,
  },
  {
    unique: true,
  },
);

export const User = mongoose.model<IUser>("User", userSchema);

