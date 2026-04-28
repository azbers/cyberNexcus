import type { Express } from "express";
import type { Pool, PoolClient } from "pg";

import type { AuthAction, AuthenticatedRequest } from "../auth/types.js";
import { toHttpError } from "../auth/middleware.js";
import { withTransaction } from "../db/transaction.js";
import { PisfService } from "./service.js";

type RegisterPisfRoutesOptions = {
  app: Express;
  pool: Pool;
  txOverride?: PoolClient;
  requireAuth: (action: AuthAction) => import("express").RequestHandler;
  service: PisfService;
};

export function registerPisfRoutes(options: RegisterPisfRoutesOptions): void {
  const requestMeta = (req: AuthenticatedRequest) => ({
    claims: req.auth!,
  });

  options.app.get("/pisf/domains", options.requireAuth("PISF_READ"), async (req, res) => {
    try {
      const page = Number(req.query.page ?? 1);
      const pageSize = Number(req.query.pageSize ?? 25);
      const result = await withTransaction(
        options.pool,
        (tx) => options.service.listDomains(tx, requestMeta(req as AuthenticatedRequest).claims, { page, pageSize }),
        options.txOverride,
      );
      res.status(200).json(result);
    } catch (err) {
      toHttpError(res, err);
    }
  });

  options.app.get(
    "/pisf/domains/:domainId",
    options.requireAuth("PISF_READ"),
    async (req, res) => {
      try {
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.getDomainById(
              tx,
              requestMeta(req as AuthenticatedRequest).claims,
              String(req.params.domainId ?? ""),
            ),
          options.txOverride,
        );
        res.status(200).json(result);
      } catch (err) {
        toHttpError(res, err);
      }
    },
  );

  options.app.get("/pisf/controls", options.requireAuth("PISF_READ"), async (req, res) => {
    try {
      const page = Number(req.query.page ?? 1);
      const pageSize = Number(req.query.pageSize ?? 25);
      const result = await withTransaction(
        options.pool,
        (tx) =>
          options.service.listControls(
            tx,
            requestMeta(req as AuthenticatedRequest).claims,
            {
              domainId: req.query.domainId ? String(req.query.domainId) : undefined,
              phase: req.query.phase ? String(req.query.phase) : undefined,
              search: req.query.search ? String(req.query.search) : undefined,
              page,
              pageSize,
            },
          ),
        options.txOverride,
      );
      res.status(200).json(result);
    } catch (err) {
      toHttpError(res, err);
    }
  });

  options.app.get(
    "/pisf/controls/:controlId",
    options.requireAuth("PISF_READ"),
    async (req, res) => {
      try {
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.getControlById(
              tx,
              requestMeta(req as AuthenticatedRequest).claims,
              String(req.params.controlId ?? ""),
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
    "/pisf/requirements",
    options.requireAuth("PISF_READ"),
    async (req, res) => {
      try {
        const page = Number(req.query.page ?? 1);
        const pageSize = Number(req.query.pageSize ?? 25);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.listRequirements(
              tx,
              requestMeta(req as AuthenticatedRequest).claims,
              {
                domainId: req.query.domainId ? String(req.query.domainId) : undefined,
                controlId: req.query.controlId ? String(req.query.controlId) : undefined,
                status: req.query.status ? String(req.query.status) : undefined,
                page,
                pageSize,
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
    "/pisf/requirements/:requirementId",
    options.requireAuth("PISF_READ"),
    async (req, res) => {
      try {
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.getRequirementById(
              tx,
              requestMeta(req as AuthenticatedRequest).claims,
              String(req.params.requirementId ?? ""),
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
