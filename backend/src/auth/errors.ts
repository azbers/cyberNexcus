export class AuthError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  public constructor(
    code: string,
    statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const AUTH_ERRORS = {
  INVALID_LOGIN: () =>
    new AuthError(
      "INVALID_LOGIN",
      401,
      "Invalid email or password",
    ),
  FORCE_REAUTH: () =>
    new AuthError("FORCE_REAUTH", 401, "Re-authentication required"),
  UNAUTHORIZED: () => new AuthError("UNAUTHORIZED", 401, "Unauthorized"),
  RATE_LIMITED: () => new AuthError("RATE_LIMITED", 429, "Too many requests"),
  CONFLICT: () => new AuthError("CONFLICT", 409, "Conflict"),
  FORBIDDEN_ACTION: () => new AuthError("FORBIDDEN_ACTION", 403, "Forbidden action"),
  ORG_NOT_FOUND: () => new AuthError("ORG_NOT_FOUND", 404, "Organization not found"),
  PISF_RESOURCE_NOT_FOUND: () =>
    new AuthError("PISF_RESOURCE_NOT_FOUND", 404, "PISF resource not found"),
  ASSESSMENT_CYCLE_NOT_FOUND: () =>
    new AuthError("ASSESSMENT_CYCLE_NOT_FOUND", 404, "Assessment cycle not found"),
  ASSESSMENT_ITEM_NOT_FOUND: () =>
    new AuthError("ASSESSMENT_ITEM_NOT_FOUND", 404, "Assessment requirement item not found"),
  ASSESSMENT_ALREADY_HAS_DRAFT: () =>
    new AuthError("ASSESSMENT_ALREADY_HAS_DRAFT", 409, "Organization already has an active draft assessment cycle"),
  ASSESSMENT_FINALIZE_BLOCKED_UNASSESSED: () =>
    new AuthError("ASSESSMENT_FINALIZE_BLOCKED_UNASSESSED", 409, "Assessment cycle contains unresolved UNASSESSED items"),
  ASSESSMENT_CYCLE_FINALIZED: () =>
    new AuthError("ASSESSMENT_CYCLE_FINALIZED", 409, "Assessment cycle is finalized"),
  INVALID_ASSESSMENT_STATUS: () =>
    new AuthError("INVALID_ASSESSMENT_STATUS", 400, "Invalid assessment status"),
  ASSESSMENT_FINALIZE_BLOCKED_MISSING_EVIDENCE_CHECKLIST: () =>
    new AuthError(
      "ASSESSMENT_FINALIZE_BLOCKED_MISSING_EVIDENCE_CHECKLIST",
      409,
      "Assessment cycle contains items missing evidence checklist",
    ),
  EVIDENCE_CHECKLIST_NOT_FOUND: () =>
    new AuthError(
      "EVIDENCE_CHECKLIST_NOT_FOUND",
      404,
      "Evidence checklist not found",
    ),
  INVALID_EVIDENCE_CHECKLIST: () =>
    new AuthError(
      "INVALID_EVIDENCE_CHECKLIST",
      400,
      "Invalid evidence checklist",
    ),
  ASSESSMENT_SCORE_NOT_FOUND: () =>
    new AuthError(
      "ASSESSMENT_SCORE_NOT_FOUND",
      404,
      "Assessment score not found",
    ),
  ASSESSMENT_SCORE_REQUIRES_FINALIZED_INTERNAL: () =>
    new AuthError(
      "ASSESSMENT_SCORE_REQUIRES_FINALIZED_INTERNAL",
      409,
      "Assessment score can only be calculated for finalized internal cycles",
    ),
  ASSESSMENT_SCORE_BLOCKED_UNASSESSED: () =>
    new AuthError(
      "ASSESSMENT_SCORE_BLOCKED_UNASSESSED",
      409,
      "Assessment score calculation is blocked by UNASSESSED items",
    ),
  ASSESSMENT_SCORE_BLOCKED_MISSING_EVIDENCE_CHECKLIST: () =>
    new AuthError(
      "ASSESSMENT_SCORE_BLOCKED_MISSING_EVIDENCE_CHECKLIST",
      409,
      "Assessment score calculation is blocked by missing evidence checklist",
    ),
  SUBMISSION_READINESS_NOT_FOUND: () =>
    new AuthError(
      "SUBMISSION_READINESS_NOT_FOUND",
      404,
      "Submission readiness record not found",
    ),
  INVALID_SUBMISSION_READINESS: () =>
    new AuthError(
      "INVALID_SUBMISSION_READINESS",
      400,
      "Invalid submission readiness payload",
    ),
  SUBMISSION_READINESS_REQUIRES_FINALIZED_INTERNAL: () =>
    new AuthError(
      "SUBMISSION_READINESS_REQUIRES_FINALIZED_INTERNAL",
      409,
      "Submission readiness requires a finalized internal assessment cycle",
    ),
  SUBMISSION_READINESS_LOCKED: () =>
    new AuthError(
      "SUBMISSION_READINESS_LOCKED",
      409,
      "Submission readiness is locked",
    ),
  SUBMISSION_READINESS_INCOMPLETE: () =>
    new AuthError(
      "SUBMISSION_READINESS_INCOMPLETE",
      409,
      "Submission readiness checklist is incomplete",
    ),
  ASSESSMENT_SCORE_REQUIRED: () =>
    new AuthError(
      "ASSESSMENT_SCORE_REQUIRED",
      409,
      "Assessment score snapshot is required",
    ),
  ASSESSMENT_SCORE_STALE: () =>
    new AuthError(
      "ASSESSMENT_SCORE_STALE",
      409,
      "Assessment score snapshot is stale",
    ),
  SUBMISSION_PACKAGE_NOT_FOUND: () =>
    new AuthError(
      "SUBMISSION_PACKAGE_NOT_FOUND",
      404,
      "Submission package not found",
    ),
  SUBMISSION_PACKAGE_ALREADY_EXISTS: () =>
    new AuthError(
      "SUBMISSION_PACKAGE_ALREADY_EXISTS",
      409,
      "Active submission package already exists for assessment cycle",
    ),
  SUBMISSION_PACKAGE_REQUIRES_READY_FOR_SUBMISSION: () =>
    new AuthError(
      "SUBMISSION_PACKAGE_REQUIRES_READY_FOR_SUBMISSION",
      409,
      "Submission package requires a ready-for-submission assessment cycle",
    ),
  INVALID_SUBMISSION_PACKAGE_VOID_REASON: () =>
    new AuthError(
      "INVALID_SUBMISSION_PACKAGE_VOID_REASON",
      400,
      "Invalid submission package void reason",
    ),
  EXTERNAL_SUBMISSION_NOT_FOUND: () =>
    new AuthError(
      "EXTERNAL_SUBMISSION_NOT_FOUND",
      404,
      "External submission not found",
    ),
  EXTERNAL_SUBMISSION_ALREADY_EXISTS: () =>
    new AuthError(
      "EXTERNAL_SUBMISSION_ALREADY_EXISTS",
      409,
      "Active external submission already exists for submission package",
    ),
  INVALID_EXTERNAL_SUBMISSION_WITHDRAW_REASON: () =>
    new AuthError(
      "INVALID_EXTERNAL_SUBMISSION_WITHDRAW_REASON",
      400,
      "Invalid external submission withdraw reason",
    ),
  INVALID_EXTERNAL_SUBMISSION_STATUS_FILTER: () =>
    new AuthError(
      "INVALID_EXTERNAL_SUBMISSION_STATUS_FILTER",
      400,
      "Invalid external submission status filter",
    ),
  SUBMISSION_PACKAGE_INTEGRITY_FAILED: () =>
    new AuthError(
      "SUBMISSION_PACKAGE_INTEGRITY_FAILED",
      409,
      "Submission package integrity check failed",
    ),
  SUBMISSION_PACKAGE_NOT_SUBMITTABLE: () =>
    new AuthError(
      "SUBMISSION_PACKAGE_NOT_SUBMITTABLE",
      409,
      "Submission package is not submittable",
    ),
  PACKAGE_HAS_ACTIVE_SUBMISSION: () =>
    new AuthError(
      "PACKAGE_HAS_ACTIVE_SUBMISSION",
      409,
      "Submission package has an active external submission",
    ),
  EXTERNAL_SUBMISSION_WITHDRAWN: () =>
    new AuthError(
      "EXTERNAL_SUBMISSION_WITHDRAWN",
      409,
      "External submission has been withdrawn",
    ),
  PKCERT_ACCESS_REQUIRED: () =>
    new AuthError(
      "PKCERT_ACCESS_REQUIRED",
      403,
      "Active PKCERT access is required",
    ),
  PKCERT_REVIEWER_NOT_FOUND: () =>
    new AuthError(
      "PKCERT_REVIEWER_NOT_FOUND",
      404,
      "PKCERT reviewer not found",
    ),
  PKCERT_INTAKE_NOT_FOUND: () =>
    new AuthError(
      "PKCERT_INTAKE_NOT_FOUND",
      404,
      "PKCERT intake review not found",
    ),
  INVALID_PKCERT_INTAKE_STATUS_FILTER: () =>
    new AuthError(
      "INVALID_PKCERT_INTAKE_STATUS_FILTER",
      400,
      "Invalid PKCERT intake status filter",
    ),
  INVALID_PKCERT_INTAKE_STATUS: () =>
    new AuthError(
      "INVALID_PKCERT_INTAKE_STATUS",
      409,
      "Invalid PKCERT intake status transition",
    ),
  PKCERT_INTAKE_NOT_ASSIGNED: () =>
    new AuthError(
      "PKCERT_INTAKE_NOT_ASSIGNED",
      403,
      "PKCERT intake review is not assigned to actor",
    ),
  INVALID_PKCERT_INTAKE_NOTES: () =>
    new AuthError(
      "INVALID_PKCERT_INTAKE_NOTES",
      400,
      "Invalid PKCERT intake notes",
    ),
  PKCERT_DECISION_NOT_FOUND: () =>
    new AuthError(
      "PKCERT_DECISION_NOT_FOUND",
      404,
      "PKCERT decision not found",
    ),
  PKCERT_DECISION_ALREADY_EXISTS: () =>
    new AuthError(
      "PKCERT_DECISION_ALREADY_EXISTS",
      409,
      "PKCERT decision already exists for external submission",
    ),
  INVALID_PKCERT_DECISION: () =>
    new AuthError(
      "INVALID_PKCERT_DECISION",
      400,
      "Invalid PKCERT decision",
    ),
  PKCERT_DECISION_REQUIRES_INTAKE_REVIEWED: () =>
    new AuthError(
      "PKCERT_DECISION_REQUIRES_INTAKE_REVIEWED",
      409,
      "PKCERT decision requires completed intake review",
    ),
  EXTERNAL_SUBMISSION_DECIDED: () =>
    new AuthError(
      "EXTERNAL_SUBMISSION_DECIDED",
      409,
      "External submission already has a PKCERT decision",
    ),
  CORRECTION_RESUBMISSION_NOT_FOUND: () =>
    new AuthError(
      "CORRECTION_RESUBMISSION_NOT_FOUND",
      404,
      "Correction resubmission not found",
    ),
  CORRECTION_RESUBMISSION_ALREADY_EXISTS: () =>
    new AuthError(
      "CORRECTION_RESUBMISSION_ALREADY_EXISTS",
      409,
      "Active correction resubmission already exists for decision",
    ),
  CORRECTION_RESUBMISSION_REQUIRES_RETURNED_DECISION: () =>
    new AuthError(
      "CORRECTION_RESUBMISSION_REQUIRES_RETURNED_DECISION",
      409,
      "Correction resubmission requires a returned-for-correction decision",
    ),
  INVALID_CORRECTION_RESUBMISSION: () =>
    new AuthError(
      "INVALID_CORRECTION_RESUBMISSION",
      400,
      "Invalid correction resubmission payload",
    ),
  INVALID_CORRECTION_RESUBMISSION_STATUS: () =>
    new AuthError(
      "INVALID_CORRECTION_RESUBMISSION_STATUS",
      409,
      "Invalid correction resubmission status transition",
    ),
  INVALID_CORRECTION_RESUBMISSION_VOID_REASON: () =>
    new AuthError(
      "INVALID_CORRECTION_RESUBMISSION_VOID_REASON",
      400,
      "Invalid correction resubmission void reason",
    ),
  CORRECTION_EXECUTION_CYCLE_NOT_FOUND: () =>
    new AuthError(
      "CORRECTION_EXECUTION_CYCLE_NOT_FOUND",
      404,
      "Correction execution cycle not found",
    ),
  CORRECTION_EXECUTION_CYCLE_ALREADY_EXISTS: () =>
    new AuthError(
      "CORRECTION_EXECUTION_CYCLE_ALREADY_EXISTS",
      409,
      "Active correction execution cycle already exists",
    ),
  CORRECTION_EXECUTION_REQUIRES_READY_CORRECTION: () =>
    new AuthError(
      "CORRECTION_EXECUTION_REQUIRES_READY_CORRECTION",
      409,
      "Correction execution requires a ready correction resubmission",
    ),
  CORRECTION_EXECUTION_VOIDED: () =>
    new AuthError(
      "CORRECTION_EXECUTION_VOIDED",
      409,
      "Correction execution cycle is voided or inactive",
    ),
  INVALID_CORRECTION_EXECUTION_STATUS: () =>
    new AuthError(
      "INVALID_CORRECTION_EXECUTION_STATUS",
      409,
      "Invalid correction execution status transition",
    ),
  INVALID_CORRECTION_EXECUTION_VOID_REASON: () =>
    new AuthError(
      "INVALID_CORRECTION_EXECUTION_VOID_REASON",
      400,
      "Invalid correction execution void reason",
    ),
  EVIDENCE_FILE_REQUIRED: () =>
    new AuthError("EVIDENCE_FILE_REQUIRED", 400, "Evidence file is required"),
  EVIDENCE_FILE_INVALID: () =>
    new AuthError("EVIDENCE_FILE_INVALID", 400, "Invalid evidence file upload"),
  EVIDENCE_FILE_TYPE_NOT_ALLOWED: () =>
    new AuthError("EVIDENCE_FILE_TYPE_NOT_ALLOWED", 400, "Evidence file type is not allowed"),
  EVIDENCE_FILE_TOO_LARGE: () =>
    new AuthError("EVIDENCE_FILE_TOO_LARGE", 400, "Evidence file exceeds size limit"),
  EVIDENCE_MAX_FILES_REACHED: () =>
    new AuthError("EVIDENCE_MAX_FILES_REACHED", 409, "Maximum active evidence files reached for item"),
  EVIDENCE_NOT_FOUND: () =>
    new AuthError("EVIDENCE_NOT_FOUND", 404, "Evidence file not found"),
  EVIDENCE_ALREADY_REMOVED: () =>
    new AuthError("EVIDENCE_ALREADY_REMOVED", 409, "Evidence file is already removed"),
  EVIDENCE_REMOVE_REASON_INVALID: () =>
    new AuthError("EVIDENCE_REMOVE_REASON_INVALID", 400, "Invalid evidence removal reason"),
  EVIDENCE_STORAGE_PATH_INVALID: () =>
    new AuthError("EVIDENCE_STORAGE_PATH_INVALID", 500, "Evidence storage path is invalid"),
  INVALID_REASON: () =>
    new AuthError("INVALID_REASON", 400, "Invalid reason"),
  SENSITIVE_REAUTH_REQUIRED: () =>
    new AuthError("SENSITIVE_REAUTH_REQUIRED", 403, "Sensitive action requires re-authentication"),
  EPOCH_BUMP_REASON_REQUIRED: () =>
    new AuthError("EPOCH_BUMP_REASON_REQUIRED", 400, "Epoch bump reason is required"),
  EPOCH_BUMP_CONFIRMATION_REQUIRED: () =>
    new AuthError("EPOCH_BUMP_CONFIRMATION_REQUIRED", 400, "Epoch bump confirmation token is required"),
  EPOCH_BUMP_CONFIRMATION_INVALID: () =>
    new AuthError("EPOCH_BUMP_CONFIRMATION_INVALID", 401, "Invalid epoch bump confirmation token"),
  EPOCH_BUMP_CONFIRMATION_EXPIRED: () =>
    new AuthError("EPOCH_BUMP_CONFIRMATION_EXPIRED", 401, "Epoch bump confirmation token expired"),
  EPOCH_BUMP_CONFIRMATION_TOO_SOON: () =>
    new AuthError("EPOCH_BUMP_CONFIRMATION_TOO_SOON", 429, "Epoch bump confirmation minimum delay not reached"),
  EPOCH_BUMP_CONFIRMATION_REUSED: () =>
    new AuthError("EPOCH_BUMP_CONFIRMATION_REUSED", 409, "Epoch bump confirmation token already used"),
  EPOCH_BUMP_RATE_LIMITED: () =>
    new AuthError("EPOCH_BUMP_RATE_LIMITED", 429, "Epoch bump rate limit exceeded"),
  SERVICE_TEMPORARILY_UNAVAILABLE: () =>
    new AuthError("SERVICE_TEMPORARILY_UNAVAILABLE", 503, "Service temporarily unavailable"),
  MISSING_TX_CONTEXT: () =>
    new AuthError("MISSING_TX_CONTEXT", 500, "Transactional context is required"),
  INVALID_AUDIT_EVENT: () =>
    new AuthError("INVALID_AUDIT_EVENT", 500, "Invalid audit event payload"),
} as const;
