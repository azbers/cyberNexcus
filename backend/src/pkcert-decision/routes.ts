import type { Express } from "express";
import type { Pool, PoolClient } from "pg";

import { toHttpError } from "../auth/middleware.js";
import type { AuthAction, AuthenticatedRequest } from "../auth/types.js";
import { withTransaction } from "../db/transaction.js";
import { PkcertDecisionService } from "./service.js";

type RegisterPkcertDecisionRoutesOptions = {
  app: Express;
  pool: Pool;
  txOverride?: PoolClient;
  requireAuth: (action: AuthAction) => import("express").RequestHandler;
  service: PkcertDecisionService;
};

export function registerPkcertDecisionRoutes(
  options: RegisterPkcertDecisionRoutesOptions,
): void {
  const requestMeta = (req: AuthenticatedRequest) => ({
    claims: req.auth!,
    meta: {
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    },
  });

  options.app.post(
    "/pkcert/intake/submissions/:externalSubmissionId/decision",
    options.requireAuth("PKCERT_DECISION_CREATE"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.createDecision(
              tx,
              auth.claims,
              String(req.params.externalSubmissionId ?? ""),
              {
                decision: req.body.decision,
                decisionReason: req.body.decisionReason,
              },
              auth.meta,
            ),
          options.txOverride,
        );
        res.status(201).json(result);
      } catch (err) {
        toHttpError(res, err);
      }
    },
  );

  options.app.get(
    "/pkcert/intake/submissions/:externalSubmissionId/decision",
    options.requireAuth("PKCERT_DECISION_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.getDecisionForPkcert(
              tx,
              auth.claims,
              String(req.params.externalSubmissionId ?? ""),
            ),
          options.txOverride,
        );
        res.status(200).json(result);
      } catch (err) {
        toHttpError(res, err);
      }
    },
  );

  options.app.get(
    "/external-submissions/:submissionId/decision",
    options.requireAuth("EXTERNAL_SUBMISSION_DECISION_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.getDecisionForOrganization(
              tx,
              auth.claims,
              String(req.params.submissionId ?? ""),
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
