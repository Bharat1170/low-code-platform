import { type ClientSession } from "mongoose";

import {
  AuditLog,
  type IAuditLog,
} from "../models/audit-log.model.js";

export const createAuditLog = async (
  data: Pick<
    IAuditLog,
    | "organizationId"
    | "userId"
    | "action"
    | "resourceType"
    | "resourceId"
    | "metadata"
    | "ipAddress"
    | "userAgent"
  >,
  dbSession?: ClientSession,
): Promise<IAuditLog> => {
  const auditLog = new AuditLog({
    organizationId: data.organizationId,
    userId: data.userId,
    action: data.action,
    resourceType: data.resourceType,
    resourceId: data.resourceId ?? null,
    metadata: data.metadata,
    ipAddress: data.ipAddress,
    userAgent: data.userAgent,
  });

  await auditLog.save({
    session: dbSession,
  });

  return auditLog;
};


export const findLatestLoginAuditLog = async (
  userId: IAuditLog["userId"],
): Promise<IAuditLog | null> => {
  return AuditLog.findOne({
    userId,
    action: "USER_LOGIN",
  })
    .sort({ createdAt: -1 })
    .exec();
};