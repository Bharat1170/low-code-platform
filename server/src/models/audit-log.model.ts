import mongoose, { Document, Schema } from "mongoose";

export interface IAuditLog extends Document {
  organizationId: mongoose.Types.ObjectId;
  /* Null for an anonymous actor (a public form submission). */
  userId: mongoose.Types.ObjectId | null;
  action: string;
  resourceType: string;
  resourceId?: mongoose.Types.ObjectId | null;
  metadata: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
  createdAt: Date;
  updatedAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    resourceType: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    resourceId: {
      type: Schema.Types.ObjectId,
      default: null,
    },

    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },

    ipAddress: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    userAgent: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
  },
  {
    timestamps: true,
  },
);

auditLogSchema.index({
  organizationId: 1,
  createdAt: -1,
});

auditLogSchema.index({
  organizationId: 1,
  userId: 1,
  createdAt: -1,
});

export const AuditLog = mongoose.model<IAuditLog>(
  "AuditLog",
  auditLogSchema,
);