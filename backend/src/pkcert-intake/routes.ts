import type { Express } from "express";
import type { Pool, PoolClient } from "pg";

import { toHttpError } from "../auth/middleware.js";
import type { AuthAction, AuthenticatedRequest } from "../auth/types.js";
import { withTransaction } from "../db/transaction.js";
import { PkcertIntakeService } from "./service.js";

type RegisterPkcertIntakeRoutesOptions = {
  app: Express;
  pool: Pool;
  txOverride?: PoolClient;
  requireAuth: (action: AuthAction) => import("express").RequestHandler;
  service: PkcertIntakeService;
};

export function registerPkcertIntakeRoutes(
  options: RegisterPkcertIntakeRoutesOptions,
): void {
  const requestMeta = (req: AuthenticatedRequest) => ({
    claims: req.auth!,
    meta: {
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    },
  });

  options.app.get(
    "/pkcert/intake/submissions",
    options.requireAuth("PKCERT_INTAKE_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.listIntakeReviews(tx, auth.claims, {
              page: Number(req.query.page ?? 1),
              pageSize: Number(req.query.pageSize ?? 25),
              status: req.query.status ? String(req.query.status) : undefined,
              assignedToMe: String(req.query.assignedToMe ?? "").toLowerCase() === "true",
            }),
          options.txOverride,
        );
        res.status(200).json(result);
      } catch (err) {
        toHttpError(res, err);
      }
    },
  );

  options.app.get(
    "/pkcert/intake/submissions/:externalSubmissionId",
    options.requireAuth("PKCERT_INTAKE_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.getIntakeReview(
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

  options.app.post(
    "/pkcert/intake/submissions/:externalSubmissionId/assign",
    options.requireAuth("PKCERT_INTAKE_ASSIGN"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.assignReviewer(
              tx,
              auth.claims,
              String(req.params.externalSubmissionId ?? ""),
              req.body.reviewerUserId,
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
    "/pkcert/intake/submissions/:externalSubmissionId/start",
    options.requireAuth("PKCERT_INTAKE_START"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.startReview(
              tx,
              auth.claims,
              String(req.params.externalSubmissionId ?? ""),
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
    "/pkcert/intake/submissions/:externalSubmissionId/mark-reviewed",
    options.requireAuth("PKCERT_INTAKE_MARK_REVIEWED"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.markReviewed(
              tx,
              auth.claims,
              String(req.params.externalSubmissionId ?? ""),
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

  options.app.put(
    "/pkcert/intake/submissions/:externalSubmissionId/notes",
    options.requireAuth("PKCERT_INTAKE_NOTES_UPDATE"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.updateNotes(
              tx,
              auth.claims,
              String(req.params.externalSubmissionId ?? ""),
              req.body.internalNotes,
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
