export const PERMISSIONS = {
  ORGANIZATION_READ: "organization.read",
  ORGANIZATION_UPDATE: "organization.update",

  USER_CREATE: "user.create",
  USER_READ: "user.read",
  USER_UPDATE: "user.update",
  USER_DELETE: "user.delete",

  PROJECT_CREATE: "project.create",
  PROJECT_READ: "project.read",
  PROJECT_UPDATE: "project.update",
  PROJECT_DELETE: "project.delete",

  FORM_CREATE: "form.create",
  FORM_READ: "form.read",
  FORM_UPDATE: "form.update",
  FORM_DELETE: "form.delete",
  FORM_PUBLISH: "form.publish",

  SUBMISSION_CREATE: "submission.create",
  SUBMISSION_READ: "submission.read",
  SUBMISSION_UPDATE: "submission.update",
  SUBMISSION_DELETE: "submission.delete",
} as const;

export type Permission =
  (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const PERMISSION_VALUES: ReadonlySet<string> = new Set(
  Object.values(PERMISSIONS),
);

/*
 * Role documents store permissions as plain strings. Anything that is
 * not a known permission (typos, wildcards, legacy values) is ignored.
 */
export const isPermission = (
  value: string,
): value is Permission => {
  return PERMISSION_VALUES.has(value);
};
