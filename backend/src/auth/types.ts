import type { Request } from "express";

export const ORG_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
] as const;

export type OrgStatus = (typeof ORG_STATUSES)[number];

export const AUDIT_EVENT_TYPES = [
  "REGISTER",
  "VERIFY_EMAIL",
  "LOGIN_SUCCESS",
  "LOGIN_FAILED",
  "REFRESH",
  "TOKEN_REUSE_DETECTED",
  "LOGOUT",
  "LOGOUT_ALL",
  "LOCKOUT_TRIGGERED",
  "CRITICAL_SECURITY_EVENT",
  "TOKEN_EPOCH_BUMP_DRY_RUN",
  "ORG_APPROVED",
  "ORG_REJECTED",
  "ORG_SUSPENDED",
  "ORG_REACTIVATED",
  "ASSESSMENT_DRAFT_CREATED",
  "ASSESSMENT_ITEM_STATUS_UPDATED",
  "ASSESSMENT_INTERNAL_FINALIZED",
  "EVIDENCE_UPLOADED",
  "EVIDENCE_REMOVED",
  "EVIDENCE_DOWNLOADED",
  "EVIDENCE_CHECKLIST_UPSERTED",
  "ASSESSMENT_SCORE_CALCULATED",
  "SUBMISSION_READINESS_UPSERTED",
  "ASSESSMENT_MARKED_READY_FOR_SUBMISSION",
  "SUBMISSION_PACKAGE_CREATED",
  "SUBMISSION_PACKAGE_VOIDED",
  "EXTERNAL_SUBMISSION_CREATED",
  "EXTERNAL_SUBMISSION_WITHDRAWN",
  "PKCERT_INTAKE_CREATED",
  "PKCERT_INTAKE_ASSIGNED",
  "PKCERT_INTAKE_STARTED",
  "PKCERT_INTAKE_REVIEWED",
  "PKCERT_INTAKE_NOTES_UPDATED",
  "PKCERT_DECISION_RECORDED",
  "CORRECTION_RESUBMISSION_CREATED",
  "CORRECTION_RESUBMISSION_SUMMARY_UPDATED",
  "CORRECTION_RESUBMISSION_MARKED_READY",
  "CORRECTION_RESUBMISSION_VOIDED",
  "CORRECTION_EXECUTION_CYCLE_CREATED",
  "CORRECTION_EXECUTION_CYCLE_VOIDED",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const AUDIT_SEVERITIES = ["INFO", "WARNING", "CRITICAL"] as const;

export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

export type AuthTokenKind = "access" | "refresh";

export const AUTH_ACTIONS = [
  "READ_SELF_PROFILE",
  "TERMINATE_CURRENT_SESSION",
  "ROTATE_SESSION",
  "REVOKE_ALL_SESSIONS",
  "BUMP_TOKEN_EPOCH",
  "ORG_LIST_PENDING",
  "ORG_APPROVE",
  "ORG_REJECT",
  "ORG_SUSPEND",
  "ORG_REACTIVATE",
  "PISF_READ",
  "ASSESSMENT_READ",
  "ASSESSMENT_CREATE_DRAFT",
  "ASSESSMENT_UPDATE_ITEM",
  "ASSESSMENT_FINALIZE_INTERNAL",
  "EVIDENCE_READ",
  "EVIDENCE_UPLOAD",
  "EVIDENCE_REMOVE",
  "EVIDENCE_CHECKLIST_READ",
  "EVIDENCE_CHECKLIST_UPSERT",
  "ASSESSMENT_SCORE_CALCULATE",
  "ASSESSMENT_SCORE_READ",
  "SUBMISSION_READINESS_READ",
  "SUBMISSION_READINESS_UPSERT",
  "ASSESSMENT_MARK_READY_FOR_SUBMISSION",
  "SUBMISSION_PACKAGE_READ",
  "SUBMISSION_PACKAGE_CREATE",
  "SUBMISSION_PACKAGE_VOID",
  "EXTERNAL_SUBMISSION_READ",
  "EXTERNAL_SUBMISSION_SUBMIT",
  "EXTERNAL_SUBMISSION_WITHDRAW",
  "PKCERT_INTAKE_READ",
  "PKCERT_INTAKE_ASSIGN",
  "PKCERT_INTAKE_START",
  "PKCERT_INTAKE_MARK_REVIEWED",
  "PKCERT_INTAKE_NOTES_UPDATE",
  "PKCERT_DECISION_CREATE",
  "PKCERT_DECISION_READ",
  "EXTERNAL_SUBMISSION_DECISION_READ",
  "CORRECTION_RESUBMISSION_READ",
  "CORRECTION_RESUBMISSION_CREATE",
  "CORRECTION_RESUBMISSION_SUMMARY_UPDATE",
  "CORRECTION_RESUBMISSION_MARK_READY",
  "CORRECTION_RESUBMISSION_VOID",
  "CORRECTION_EXECUTION_READ",
  "CORRECTION_EXECUTION_CREATE",
  "CORRECTION_EXECUTION_VOID",
] as const;

export type AuthAction = (typeof AUTH_ACTIONS)[number];

export const AUTH_ACTION_POLICY: Record<AuthAction, { requiresFreshAuth: boolean }> = {
  READ_SELF_PROFILE: { requiresFreshAuth: false },
  TERMINATE_CURRENT_SESSION: { requiresFreshAuth: false },
  ROTATE_SESSION: { requiresFreshAuth: true },
  REVOKE_ALL_SESSIONS: { requiresFreshAuth: true },
  BUMP_TOKEN_EPOCH: { requiresFreshAuth: true },
  ORG_LIST_PENDING: { requiresFreshAuth: false },
  ORG_APPROVE: { requiresFreshAuth: false },
  ORG_REJECT: { requiresFreshAuth: false },
  ORG_SUSPEND: { requiresFreshAuth: false },
  ORG_REACTIVATE: { requiresFreshAuth: false },
  PISF_READ: { requiresFreshAuth: false },
  ASSESSMENT_READ: { requiresFreshAuth: false },
  ASSESSMENT_CREATE_DRAFT: { requiresFreshAuth: false },
  ASSESSMENT_UPDATE_ITEM: { requiresFreshAuth: false },
  ASSESSMENT_FINALIZE_INTERNAL: { requiresFreshAuth: false },
  EVIDENCE_READ: { requiresFreshAuth: false },
  EVIDENCE_UPLOAD: { requiresFreshAuth: false },
  EVIDENCE_REMOVE: { requiresFreshAuth: false },
  EVIDENCE_CHECKLIST_READ: { requiresFreshAuth: false },
  EVIDENCE_CHECKLIST_UPSERT: { requiresFreshAuth: false },
  ASSESSMENT_SCORE_CALCULATE: { requiresFreshAuth: false },
  ASSESSMENT_SCORE_READ: { requiresFreshAuth: false },
  SUBMISSION_READINESS_READ: { requiresFreshAuth: false },
  SUBMISSION_READINESS_UPSERT: { requiresFreshAuth: false },
  ASSESSMENT_MARK_READY_FOR_SUBMISSION: { requiresFreshAuth: false },
  SUBMISSION_PACKAGE_READ: { requiresFreshAuth: false },
  SUBMISSION_PACKAGE_CREATE: { requiresFreshAuth: false },
  SUBMISSION_PACKAGE_VOID: { requiresFreshAuth: false },
  EXTERNAL_SUBMISSION_READ: { requiresFreshAuth: false },
  EXTERNAL_SUBMISSION_SUBMIT: { requiresFreshAuth: false },
  EXTERNAL_SUBMISSION_WITHDRAW: { requiresFreshAuth: false },
  PKCERT_INTAKE_READ: { requiresFreshAuth: false },
  PKCERT_INTAKE_ASSIGN: { requiresFreshAuth: false },
  PKCERT_INTAKE_START: { requiresFreshAuth: false },
  PKCERT_INTAKE_MARK_REVIEWED: { requiresFreshAuth: false },
  PKCERT_INTAKE_NOTES_UPDATE: { requiresFreshAuth: false },
  PKCERT_DECISION_CREATE: { requiresFreshAuth: false },
  PKCERT_DECISION_READ: { requiresFreshAuth: false },
  EXTERNAL_SUBMISSION_DECISION_READ: { requiresFreshAuth: false },
  CORRECTION_RESUBMISSION_READ: { requiresFreshAuth: false },
  CORRECTION_RESUBMISSION_CREATE: { requiresFreshAuth: false },
  CORRECTION_RESUBMISSION_SUMMARY_UPDATE: { requiresFreshAuth: false },
  CORRECTION_RESUBMISSION_MARK_READY: { requiresFreshAuth: false },
  CORRECTION_RESUBMISSION_VOID: { requiresFreshAuth: false },
  CORRECTION_EXECUTION_READ: { requiresFreshAuth: false },
  CORRECTION_EXECUTION_CREATE: { requiresFreshAuth: false },
  CORRECTION_EXECUTION_VOID: { requiresFreshAuth: false },
};

export type AuthClaims = {
  userId: string;
  orgId: string;
  sessionId: string;
  sessionFamilyId: string;
  tokenVersion: number;
  tokenKind: AuthTokenKind;
  iat: number;
  exp: number;
};

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
};

export type AuthRequestMeta = {
  ipAddress: string | null;
  userAgent: string | null;
};

export type AuthenticatedRequest = Request & {
  auth?: AuthClaims;
};

export type RateLimitDecision = {
  blocked: boolean;
  blockedUntil: Date;
  currentCount: number;
};

export const EPOCH_BUMP_REQUEST_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "EXPIRED",
  "CANCELED",
] as const;

export type EpochBumpRequestStatus = (typeof EPOCH_BUMP_REQUEST_STATUSES)[number];
