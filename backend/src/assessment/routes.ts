import type { Express } from "express";
import type { Pool, PoolClient } from "pg";

import type { AuthAction, AuthenticatedRequest } from "../auth/types.js";
import { toHttpError } from "../auth/middleware.js";
import { withTransaction } from "../db/transaction.js";
import { AssessmentService } from "./service.js";

type RegisterAssessmentRoutesOptions = {
  app: Express;
  pool: Pool;
  txOverride?: PoolClient;
  requireAuth: (action: AuthAction) => import("express").RequestHandler;
  service: AssessmentService;
};

export function registerAssessmentRoutes(
  options: RegisterAssessmentRoutesOptions,
): void {
  const requestMeta = (req: AuthenticatedRequest) => ({
    claims: req.auth!,
    meta: {
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    },
  });

  options.app.post(
    "/assessments/cycles",
    options.requireAuth("ASSESSMENT_CREATE_DRAFT"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) => options.service.createDraftCycle(tx, auth.claims, auth.meta),
          options.txOverride,
        );
        res.status(201).json(result);
      } catch (err) {
        toHttpError(res, err);
      }
    },
  );

  options.app.get(
    "/assessments/cycles",
    options.requireAuth("ASSESSMENT_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.listCycles(tx, auth.claims, {
              page: Number(req.query.page ?? 1),
              pageSize: Number(req.query.pageSize ?? 25),
              status: req.query.status ? String(req.query.status) : undefined,
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
    "/assessments/cycles/:cycleId",
    options.requireAuth("ASSESSMENT_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.getCycleById(
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
    "/assessments/cycles/:cycleId/items",
    options.requireAuth("ASSESSMENT_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.listCycleItems(
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

  options.app.get(
    "/assessments/cycles/:cycleId/items/:itemId/evidence-checklist",
    options.requireAuth("EVIDENCE_CHECKLIST_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.getEvidenceChecklist(
              tx,
              auth.claims,
              String(req.params.cycleId ?? ""),
              String(req.params.itemId ?? ""),
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
    "/assessments/cycles/:cycleId/items/:itemId/evidence-checklist",
    options.requireAuth("EVIDENCE_CHECKLIST_UPSERT"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.upsertEvidenceChecklist(
              tx,
              auth.claims,
              String(req.params.cycleId ?? ""),
              String(req.params.itemId ?? ""),
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

  options.app.patch(
    "/assessments/cycles/:cycleId/items/:itemId",
    options.requireAuth("ASSESSMENT_UPDATE_ITEM"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.updateRequirementItemStatus(
              tx,
              auth.claims,
              String(req.params.cycleId ?? ""),
              String(req.params.itemId ?? ""),
              String(req.body.assessmentStatus ?? ""),
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
    "/assessments/cycles/:cycleId/finalize-internal",
    options.requireAuth("ASSESSMENT_FINALIZE_INTERNAL"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.finalizeInternalCycle(
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
