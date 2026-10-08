import { ApiError, publicRequest } from "../../../lib/http.ts";
import type { FormSchema } from "../../form-builder/types/form-builder.types.ts";
import { isFormSchema } from "../../form-builder/utils/form-schema.validate.ts";
import { isValidPublicId } from "../../form-builder/utils/share-url.ts";
import type { FieldValues } from "../../form-renderer/types/form-renderer.types.ts";

/*
 * Share-link API. No access token is ever sent: these requests go through
 * publicRequest. The publicId is the only identifier; the server derives
 * organization, form and version, and the submission body is only { data }.
 */

export { ApiError };

export interface PublicForm {
  name: string;
  description: string;
  version: number;
  schema: FormSchema;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const path = (publicId: string): string => {
  // A malformed id never reaches the network; it reads as "not found".
  if (!isValidPublicId(publicId)) {
    throw new ApiError(404, "FORM_NOT_FOUND", "This form is not available");
  }
  return `/public/forms/${publicId}`;
};

export const fetchPublicForm = async (publicId: string): Promise<PublicForm> => {
  const body = await publicRequest(path(publicId));
  const form =
    isRecord(body) && isRecord(body.data) && isRecord(body.data.form)
      ? body.data.form
      : null;

  if (
    !form ||
    typeof form.name !== "string" ||
    typeof form.version !== "number" ||
    !isFormSchema(form.schema)
  ) {
    throw new ApiError(500, "INVALID_RESPONSE", "Unexpected server response");
  }

  return {
    name: form.name,
    description: typeof form.description === "string" ? form.description : "",
    version: form.version,
    schema: form.schema,
  };
};

export const submitPublicForm = async (
  publicId: string,
  data: FieldValues,
): Promise<void> => {
  await publicRequest(`${path(publicId)}/submissions`, {
    method: "POST",
    body: JSON.stringify({ data }),
  });
};
