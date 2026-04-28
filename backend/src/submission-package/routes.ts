import type { Express } from "express";
import type { Pool, PoolClient } from "pg";

import { toHttpError } from "../auth/middleware.js";
import type { AuthAction, AuthenticatedRequest } from "../auth/types.js";
import { withTransaction } from "../db/transaction.js";
import { SubmissionPackageService } from "./service.js";

type RegisterSubmissionPackageRoutesOptions = {
  app: Express;
  pool: Pool;
  txOverride?: PoolClient;
  requireAuth: (action: AuthAction) => import("express").RequestHandler;
  service: SubmissionPackageService;
};

export function registerSubmissionPackageRoutes(
  options: RegisterSubmissionPackageRoutesOptions,
): void {
  const requestMeta = (req: AuthenticatedRequest) => ({
    claims: req.auth!,
    meta: {
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    },
  });

  options.app.post(
    "/assessments/cycles/:cycleId/submission-package",
    options.requireAuth("SUBMISSION_PACKAGE_CREATE"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.createPackage(
              tx,
              auth.claims,
              String(req.params.cycleId ?? ""),
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
    "/assessments/cycles/:cycleId/submission-package",
    options.requireAuth("SUBMISSION_PACKAGE_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.getActivePackageByCycle(
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

  options.app.get(
    "/submission-packages/:packageId",
    options.requireAuth("SUBMISSION_PACKAGE_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.getPackageById(
              tx,
              auth.claims,
              String(req.params.packageId ?? ""),
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
    "/submission-packages/:packageId/void",
    options.requireAuth("SUBMISSION_PACKAGE_VOID"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.voidPackage(
              tx,
              auth.claims,
              String(req.params.packageId ?? ""),
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
}
