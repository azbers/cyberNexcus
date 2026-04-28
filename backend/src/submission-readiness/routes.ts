import type { Express } from "express";
import type { Pool, PoolClient } from "pg";

import { toHttpError } from "../auth/middleware.js";
import type { AuthAction, AuthenticatedRequest } from "../auth/types.js";
import { withTransaction } from "../db/transaction.js";
import { SubmissionReadinessService } from "./service.js";

type RegisterSubmissionReadinessRoutesOptions = {
  app: Express;
  pool: Pool;
  txOverride?: PoolClient;
  requireAuth: (action: AuthAction) => import("express").RequestHandler;
  service: SubmissionReadinessService;
};

export function registerSubmissionReadinessRoutes(
  options: RegisterSubmissionReadinessRoutesOptions,
): void {
  const requestMeta = (req: AuthenticatedRequest) => ({
    claims: req.auth!,
    meta: {
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    },
  });

  options.app.get(
    "/assessments/cycles/:cycleId/submission-readiness",
    options.requireAuth("SUBMISSION_READINESS_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.getReadiness(
              tx,
              auth.claims,
              String(req.params.cycleId ?? ""),
            ),
          options.txOverride,
        );
        res.status(200).json(result);
      } catch (err) {
        toHttpError(res, err);
      }
    },
  );

  options.app.put(
    "/assessments/cycles/:cycleId/submission-readiness",
    options.requireAuth("SUBMISSION_READINESS_UPSERT"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.upsertReadiness(
              tx,
              auth.claims,
              String(req.params.cycleId ?? ""),
              req.body,
              auth.meta,
            ),
          options.txOverride,
        );
        res.status(200).json(result);
      } catch (err) {
        toHttpError(res, err);
      }
    },
  );

  options.app.post(
    "/assessments/cycles/:cycleId/mark-ready-for-submission",
    options.requireAuth("ASSESSMENT_MARK_READY_FOR_SUBMISSION"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.markReadyForSubmission(
              tx,
              auth.claims,
              String(req.params.cycleId ?? ""),
              auth.meta,
            ),
          options.txOverride,
        );
        res.status(200).json(result);
      } catch (err) {
        toHttpError(res, err);
      }
    },
  );
}
