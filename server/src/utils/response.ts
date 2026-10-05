import type { Response } from "express";

export interface ApiSuccessBody<T> {
  success: true;
  message: string;
  data?: T;
  meta?: Record<string, unknown>;
}

export interface ApiErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    fields: Record<string, string>;
  };
}

export const sendSuccess = <T>(
  res: Response,
  statusCode: number,
  message: string,
  data?: T,
  meta?: Record<string, unknown>,
): void => {
  const body: ApiSuccessBody<T> = {
    success: true,
    message,
  };

  if (data !== undefined) {
    body.data = data;
  }

  if (meta !== undefined) {
    body.meta = meta;
  }

  res.status(statusCode).json(body);
};

export const buildErrorBody = (
  code: string,
  message: string,
  fields: Record<string, string> = {},
): ApiErrorBody => {
  return {
    success: false,
    error: {
      code,
      message,
      fields,
    },
  };
};
