import type { Express } from "express";
import type { Pool, PoolClient } from "pg";

import { toHttpError } from "../auth/middleware.js";
import type { AuthAction, AuthenticatedRequest } from "../auth/types.js";
import { withTransaction } from "../db/transaction.js";
import { CorrectionResubmissionService } from "./service.js";

type RegisterCorrectionResubmissionRoutesOptions = {
  app: Express;
  pool: Pool;
  txOverride?: PoolClient;
  requireAuth: (action: AuthAction) => import("express").RequestHandler;
  service: CorrectionResubmissionService;
};

export function registerCorrectionResubmissionRoutes(
  options: RegisterCorrectionResubmissionRoutesOptions,
): void {
  const requestMeta = (req: AuthenticatedRequest) => ({
    claims: req.auth!,
    meta: {
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    },
  });

  options.app.post(
    "/external-submissions/:submissionId/correction-resubmissions",
    options.requireAuth("CORRECTION_RESUBMISSION_CREATE"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.createCorrection(
              tx,
              auth.claims,
              String(req.params.submissionId ?? ""),
              { correctionReason: req.body.correctionReason },
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
    "/external-submissions/:submissionId/correction-resubmissions",
    options.requireAuth("CORRECTION_RESUBMISSION_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.listCorrectionsForSubmission(
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
    "/correction-resubmissions/:correctionId",
    options.requireAuth("CORRECTION_RESUBMISSION_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.getCorrectionById(
              tx,
              auth.claims,
              String(req.params.correctionId ?? ""),
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
    "/correction-resubmissions/:correctionId/summary",
    options.requireAuth("CORRECTION_RESUBMISSION_SUMMARY_UPDATE"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.updateSummary(
              tx,
              auth.claims,
              String(req.params.correctionId ?? ""),
              { correctionSummary: req.body.correctionSummary },
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
    "/correction-resubmissions/:correctionId/mark-ready",
    options.requireAuth("CORRECTION_RESUBMISSION_MARK_READY"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.markReady(
              tx,
              auth.claims,
              String(req.params.correctionId ?? ""),
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
    "/correction-resubmissions/:correctionId/void",
    options.requireAuth("CORRECTION_RESUBMISSION_VOID"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.voidCorrection(
              tx,
              auth.claims,
              String(req.params.correctionId ?? ""),
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
