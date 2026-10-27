import type { ErrorRequestHandler, RequestHandler } from "express";

// The one error format for every endpoint (approved U36): { error: { code, message, fields? } }.
// `fields` is keyed by the form's own field names, so the frontend can show each message under its field.

export type ErrorBody = { error: { code: string; message: string; fields?: Record<string, string> } };

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const GENERIC_MESSAGE = "Something went wrong.";

export const unauthenticated = () => new HttpError(401, "unauthenticated", "Please sign in.");
export const forbidden = () => new HttpError(403, "forbidden", "You don't have access to do that.");
export const notFound = (what = "Record") => new HttpError(404, "not_found", `${what} not found.`);
export const validationFailed = (fields: Record<string, string>) =>
  new HttpError(422, "validation_failed", "Some fields need attention.", fields);
export const conflict = (code: string, message: string, fields?: Record<string, string>) => new HttpError(409, code, message, fields);

export function errorBody(error: HttpError): ErrorBody {
  return { error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) } };
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(notFound("Endpoint"));

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.status).json(errorBody(error));
    return;
  }
  // body-parser errors: oversized (413) and malformed JSON (400).
  const status = typeof error?.status === "number" ? error.status : 500;
  if (status === 413) {
    res.status(413).json(errorBody(new HttpError(413, "too_large", "The request is too large.")));
    return;
  }
  if (status === 400) {
    res.status(400).json(errorBody(new HttpError(400, "bad_request", GENERIC_MESSAGE)));
    return;
  }
  // Never echo internals to the client (no stack traces, B9). Log the error itself, not request bodies.
  console.error(error);
  res.status(500).json(errorBody(new HttpError(500, "server_error", GENERIC_MESSAGE)));
};
