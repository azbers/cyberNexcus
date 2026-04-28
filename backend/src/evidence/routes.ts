import type { Express } from "express";
import multer, { MulterError } from "multer";
import type { Pool, PoolClient } from "pg";

import type { AuthAction, AuthenticatedRequest } from "../auth/types.js";
import { AUTH_ERRORS } from "../auth/errors.js";
import { toHttpError } from "../auth/middleware.js";
import { withTransaction } from "../db/transaction.js";
import { EvidenceService } from "./service.js";

type RegisterEvidenceRoutesOptions = {
  app: Express;
  pool: Pool;
  txOverride?: PoolClient;
  requireAuth: (action: AuthAction) => import("express").RequestHandler;
  service: EvidenceService;
};

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

type UploadFile = {
  originalName: string;
  mimeType: string | null;
  size: number;
  buffer: Buffer;
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: MAX_FILE_SIZE_BYTES,
  },
});

function parseSingleFile(req: AuthenticatedRequest, res: unknown): Promise<UploadFile | null> {
  return new Promise((resolve, reject) => {
    upload.single("file")(req as any, res as any, (err: unknown) => {
      if (!err) {
        const file = (req as any).file as Express.Multer.File | undefined;
        if (!file) {
          resolve(null);
          return;
        }
        resolve({
          originalName: file.originalname,
          mimeType: file.mimetype ?? null,
          size: file.size,
          buffer: file.buffer,
        });
        return;
      }
      if (err instanceof MulterError) {
        const multerErr = err as MulterError;
        if (multerErr.code === "LIMIT_FILE_SIZE") {
          reject(AUTH_ERRORS.EVIDENCE_FILE_TOO_LARGE());
          return;
        }
        reject(AUTH_ERRORS.EVIDENCE_FILE_INVALID());
        return;
      }
      reject(err);
    });
  });
}

export function registerEvidenceRoutes(
  options: RegisterEvidenceRoutesOptions,
): void {
  const requestMeta = (req: AuthenticatedRequest) => ({
    claims: req.auth!,
    meta: {
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    },
  });

  options.app.post(
    "/assessments/cycles/:cycleId/items/:itemId/evidence",
    options.requireAuth("EVIDENCE_UPLOAD"),
    async (req, res) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const file = await parseSingleFile(authReq, res);
        const auth = requestMeta(authReq);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.uploadEvidence(
              tx,
              auth.claims,
              {
                cycleId: String(req.params.cycleId ?? ""),
                itemId: String(req.params.itemId ?? ""),
                file,
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
    "/assessments/cycles/:cycleId/items/:itemId/evidence",
    options.requireAuth("EVIDENCE_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.listEvidence(
              tx,
              auth.claims,
              {
                cycleId: String(req.params.cycleId ?? ""),
                itemId: String(req.params.itemId ?? ""),
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
    "/evidence/:evidenceId/download",
    options.requireAuth("EVIDENCE_READ"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.downloadEvidence(
              tx,
              auth.claims,
              String(req.params.evidenceId ?? ""),
              auth.meta,
            ),
          options.txOverride,
        );
        res.setHeader("Content-Type", result.mimeTypeDetected);
        res.setHeader("Content-Length", String(result.fileSizeBytes));
        res.setHeader(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
        );
        res.status(200).send(result.content);
      } catch (err) {
        toHttpError(res, err);
      }
    },
  );

  options.app.post(
    "/evidence/:evidenceId/remove",
    options.requireAuth("EVIDENCE_REMOVE"),
    async (req, res) => {
      try {
        const auth = requestMeta(req as AuthenticatedRequest);
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.removeEvidence(
              tx,
              auth.claims,
              {
                evidenceId: String(req.params.evidenceId ?? ""),
                reason: String(req.body.reason ?? ""),
              },
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
