import type { Express } from "express";
import type { Pool, PoolClient } from "pg";

import { toHttpError } from "../auth/middleware.js";
import type { AuthAction, AuthenticatedRequest } from "../auth/types.js";
import { withTransaction } from "../db/transaction.js";
import { ExternalSubmissionService } from "./service.js";

type RegisterExternalSubmissionRoutesOptions = {
  app: Express;
  pool: Pool;
  txOverride?: PoolClient;
  requireAuth: (action: AuthAction) => import("express").RequestHandler;
  service: ExternalSubmissionService;
};

export function registerExternalSubmissionRoutes(
  options: RegisterExternalSubmissionRoutesOptions,
): void {
  const requestMeta = (req: AuthenticatedRequest) => ({
    claims: req.auth!,
    meta: {
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    },
  });

  options.app.post(
    "/submission-packages/:packageId/submit",
    options.requireAuth("EXTERNAL_SUBMISSION_SUBMIT"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.submitPackage(
              tx,
              auth.claims,
              String(req.params.packageId ?? ""),
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

  options.app.post(
    "/external-submissions/:submissionId/withdraw",
    options.requireAuth("EXTERNAL_SUBMISSION_WITHDRAW"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.withdrawSubmission(
              tx,
              auth.claims,
              String(req.params.submissionId ?? ""),
              req.body.reason,
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

  options.app.get(
    "/external-submissions/:submissionId",
    options.requireAuth("EXTERNAL_SUBMISSION_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.getSubmissionById(
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

  options.app.get(
    "/submission-packages/:packageId/submissions",
    options.requireAuth("EXTERNAL_SUBMISSION_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.listSubmissionsByPackage(
              tx,
              auth.claims,
              String(req.params.packageId ?? ""),
              {
                page: Number(req.query.page ?? 1),
                pageSize: Number(req.query.pageSize ?? 25),
                status: req.query.status ? String(req.query.status) : undefined,
              },
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
    "/assessments/cycles/:cycleId/external-submissions",
    options.requireAuth("EXTERNAL_SUBMISSION_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.listSubmissionsByCycle(
              tx,
              auth.claims,
              String(req.params.cycleId ?? ""),
              {
                page: Number(req.query.page ?? 1),
                pageSize: Number(req.query.pageSize ?? 25),
                status: req.query.status ? String(req.query.status) : undefined,
              },
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
