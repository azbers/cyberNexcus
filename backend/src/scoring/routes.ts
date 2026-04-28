import type { Express } from "express";
import type { Pool, PoolClient } from "pg";

import { toHttpError } from "../auth/middleware.js";
import type { AuthAction, AuthenticatedRequest } from "../auth/types.js";
import { withTransaction } from "../db/transaction.js";
import { ScoringService } from "./service.js";

type RegisterScoringRoutesOptions = {
  app: Express;
  pool: Pool;
  txOverride?: PoolClient;
  requireAuth: (action: AuthAction) => import("express").RequestHandler;
  service: ScoringService;
};

export function registerScoringRoutes(options: RegisterScoringRoutesOptions): void {
  const requestMeta = (req: AuthenticatedRequest) => ({
    claims: req.auth!,
    meta: {
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    },
  });

  options.app.post(
    "/assessments/cycles/:cycleId/calculate-score",
    options.requireAuth("ASSESSMENT_SCORE_CALCULATE"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.calculateScore(
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

  options.app.get(
    "/assessments/cycles/:cycleId/score",
    options.requireAuth("ASSESSMENT_SCORE_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.getScore(
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
    "/assessments/cycles/:cycleId/score/requirements",
    options.requireAuth("ASSESSMENT_SCORE_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.listRequirementScores(
              tx,
              auth.claims,
              String(req.params.cycleId ?? ""),
              {
                page: Number(req.query.page ?? 1),
                pageSize: Number(req.query.pageSize ?? 25),
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
    "/assessments/cycles/:cycleId/score/controls",
    options.requireAuth("ASSESSMENT_SCORE_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.listControlScores(
              tx,
              auth.claims,
              String(req.params.cycleId ?? ""),
              {
                page: Number(req.query.page ?? 1),
                pageSize: Number(req.query.pageSize ?? 25),
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
