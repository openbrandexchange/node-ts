// application/problem+json errors (RFC 9457) with the OBX error vocabulary (protocol.md §11).

export const ERROR_STATUS = {
  invalid_request: 400,
  validation_failed: 422,
  unauthorized: 401,
  invalid_token: 401,
  access_revoked: 401,
  insufficient_scope: 403,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  precondition_failed: 412,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  limit_exceeded: 400,
  cursor_invalid: 400,
  cursor_expired: 410,
  export_expired: 410,
  original_not_allowed: 403,
  invalid_gtin: 422,
  gtin_conflict: 409,
  position_conflict: 409,
  checksum_mismatch: 422,
  blob_missing: 422,
  upload_incomplete: 409,
  unknown_parent: 422,
  files_missing: 422,
  import_invalid: 422,
  mass_unpublish_refused: 409,
  unsafe_url: 422,
  csrf_failed: 403,
  invalid_credentials: 401,
  account_blocked: 403,
  setup_required: 409,
  setup_completed: 409,
  invite_invalid: 400,
  not_implemented: 501,
  internal_error: 500,
  service_unavailable: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

const TITLES: Record<ErrorCode, string> = {
  invalid_request: "Invalid request",
  validation_failed: "Validation failed",
  unauthorized: "Authentication required",
  invalid_token: "Invalid or expired token",
  access_revoked: "Access revoked",
  insufficient_scope: "Insufficient scope",
  forbidden: "Forbidden",
  not_found: "Not found",
  method_not_allowed: "Method not allowed",
  conflict: "Conflict",
  precondition_failed: "Precondition failed",
  payload_too_large: "Payload too large",
  unsupported_media_type: "Unsupported media type",
  rate_limited: "Too many requests",
  limit_exceeded: "Limit exceeded",
  cursor_invalid: "Invalid cursor",
  cursor_expired: "Cursor expired",
  export_expired: "Export expired",
  original_not_allowed: "Originals not allowed",
  invalid_gtin: "Invalid GTIN",
  gtin_conflict: "GTIN already in use",
  position_conflict: "Position already taken",
  checksum_mismatch: "Checksum mismatch",
  blob_missing: "File not uploaded",
  upload_incomplete: "Upload incomplete",
  unknown_parent: "Unknown parent",
  files_missing: "Files missing",
  import_invalid: "Import file unreadable",
  mass_unpublish_refused: "Mass unpublish refused",
  unsafe_url: "Unsafe URL",
  csrf_failed: "CSRF check failed",
  invalid_credentials: "Invalid credentials",
  account_blocked: "Account blocked",
  setup_required: "Setup required",
  setup_completed: "Setup already completed",
  invite_invalid: "Invalid or expired link",
  not_implemented: "Not implemented",
  internal_error: "Internal error",
  service_unavailable: "Service unavailable",
};

export interface FieldError {
  pointer: string | null;
  obx_error: ErrorCode;
  detail: string;
}

export class ObxError extends Error {
  status: number;
  constructor(
    public code: ErrorCode,
    public detail: string | null = null,
    public errors: FieldError[] = [],
    opts: { status?: number; retryAfter?: number; headers?: Record<string, string> } = {},
  ) {
    super(detail ?? code);
    this.status = opts.status ?? ERROR_STATUS[code];
    this.retryAfter = opts.retryAfter ?? null;
    this.headers = opts.headers ?? {};
  }
  retryAfter: number | null;
  headers: Record<string, string>;

  toProblem(): Record<string, unknown> {
    const p: Record<string, unknown> = {
      type: `https://openbrandexchange.com/errors/${this.code}`,
      title: TITLES[this.code],
      status: this.status,
      detail: this.detail,
      obx_error: this.code,
    };
    if (this.errors.length) p.errors = this.errors;
    if (this.retryAfter !== null) p.retry_after = this.retryAfter;
    return p;
  }
}

export const err = (code: ErrorCode, detail?: string, errors: FieldError[] = []) => new ObxError(code, detail ?? null, errors);

export function problemResponse(e: ObxError): Response {
  const headers: Record<string, string> = {
    "content-type": "application/problem+json",
    "cache-control": "no-store",
    ...e.headers,
  };
  if (e.retryAfter !== null) headers["retry-after"] = String(e.retryAfter);
  return new Response(JSON.stringify(e.toProblem()), { status: e.status, headers });
}

export function validation(errors: FieldError[], detail = "The request body is invalid."): ObxError {
  return new ObxError("validation_failed", detail, errors);
}

export function fieldError(pointer: string | null, detail: string, code: ErrorCode = "validation_failed"): FieldError {
  return { pointer, obx_error: code, detail };
}
