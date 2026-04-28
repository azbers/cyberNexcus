import express from "express";
import type { Pool, PoolClient } from "pg";

import { AuthService } from "./service.js";
import { AuthRepository } from "./repository.js";
import { createAuthMiddleware, toHttpError } from "./middleware.js";
import { AUTH_ERRORS, AuthError } from "./errors.js";
import { AuthRouteMetrics, HardCutoffGate, type HardCutoffRules } from "./pre-filter.js";
import { withTransaction, TransactionExecutionError } from "../db/transaction.js";
import type { AuthenticatedRequest } from "./types.js";
import { OrganizationRepository } from "../org/repository.js";
import { OrganizationService } from "../org/service.js";
import { PisfRepository } from "../pisf/repository.js";
import { PisfService } from "../pisf/service.js";
import { registerPisfRoutes } from "../pisf/routes.js";
import { AssessmentRepository } from "../assessment/repository.js";
import { AssessmentService } from "../assessment/service.js";
import { registerAssessmentRoutes } from "../assessment/routes.js";
import { EvidenceRepository } from "../evidence/repository.js";
import { EvidenceService } from "../evidence/service.js";
import { LocalEvidenceStorage } from "../evidence/storage.js";
import { registerEvidenceRoutes } from "../evidence/routes.js";
import { ScoringRepository } from "../scoring/repository.js";
import { ScoringService } from "../scoring/service.js";
import { registerScoringRoutes } from "../scoring/routes.js";
import { SubmissionReadinessRepository } from "../submission-readiness/repository.js";
import { SubmissionReadinessService } from "../submission-readiness/service.js";
import { registerSubmissionReadinessRoutes } from "../submission-readiness/routes.js";
import { SubmissionPackageRepository } from "../submission-package/repository.js";
import { SubmissionPackageService } from "../submission-package/service.js";
import { registerSubmissionPackageRoutes } from "../submission-package/routes.js";
import { ExternalSubmissionRepository } from "../external-submission/repository.js";
import { ExternalSubmissionService } from "../external-submission/service.js";
import { registerExternalSubmissionRoutes } from "../external-submission/routes.js";
import { PkcertIntakeRepository } from "../pkcert-intake/repository.js";
import { PkcertIntakeService } from "../pkcert-intake/service.js";
import { registerPkcertIntakeRoutes } from "../pkcert-intake/routes.js";
import { PkcertDecisionRepository } from "../pkcert-decision/repository.js";
import { PkcertDecisionService } from "../pkcert-decision/service.js";
import { registerPkcertDecisionRoutes } from "../pkcert-decision/routes.js";
import { CorrectionResubmissionRepository } from "../correction-resubmission/repository.js";
import { CorrectionResubmissionService } from "../correction-resubmission/service.js";
import { registerCorrectionResubmissionRoutes } from "../correction-resubmission/routes.js";
import { CorrectionExecutionRepository } from "../correction-execution/repository.js";
import { CorrectionExecutionService } from "../correction-execution/service.js";
import { registerCorrectionExecutionRoutes } from "../correction-execution/routes.js";

type CreateAuthAppOptions = {
  pool: Pool;
  service: AuthService;
  repository: AuthRepository;
  orgRepository?: OrganizationRepository;
  orgService?: OrganizationService;
  pisfRepository?: PisfRepository;
  pisfService?: PisfService;
  assessmentRepository?: AssessmentRepository;
  assessmentService?: AssessmentService;
  evidenceRepository?: EvidenceRepository;
  evidenceService?: EvidenceService;
  evidenceStorage?: LocalEvidenceStorage;
  scoringRepository?: ScoringRepository;
  scoringService?: ScoringService;
  submissionReadinessRepository?: SubmissionReadinessRepository;
  submissionReadinessService?: SubmissionReadinessService;
  submissionPackageRepository?: SubmissionPackageRepository;
  submissionPackageService?: SubmissionPackageService;
  externalSubmissionRepository?: ExternalSubmissionRepository;
  externalSubmissionService?: ExternalSubmissionService;
  pkcertIntakeRepository?: PkcertIntakeRepository;
  pkcertIntakeService?: PkcertIntakeService;
  pkcertDecisionRepository?: PkcertDecisionRepository;
  pkcertDecisionService?: PkcertDecisionService;
  correctionResubmissionRepository?: CorrectionResubmissionRepository;
  correctionResubmissionService?: CorrectionResubmissionService;
  correctionExecutionRepository?: CorrectionExecutionRepository;
  correctionExecutionService?: CorrectionExecutionService;
  jwtSecret: string;
  issuer?: string;
  txOverride?: PoolClient;
  hardCutoffRules?: Partial<HardCutoffRules>;
  metrics?: AuthRouteMetrics;
};

export function createAuthApp(options: CreateAuthAppOptions) {
  const app = express();
  app.use(express.json());

  const requireAuth = createAuthMiddleware({
    pool: options.pool,
    repository: options.repository,
    jwtSecret: options.jwtSecret,
    issuer: options.issuer,
    txOverride: options.txOverride,
  });
  const hardCutoff = new HardCutoffGate(options.hardCutoffRules);
  const metrics = options.metrics ?? new AuthRouteMetrics();
  const orgRepository = options.orgRepository ?? new OrganizationRepository();
  const orgService =
    options.orgService ??
    new OrganizationService({
      repository: orgRepository,
    });
  const pisfRepository = options.pisfRepository ?? new PisfRepository(options.pool);
  const pisfService = options.pisfService ?? new PisfService(pisfRepository);
  const assessmentRepository =
    options.assessmentRepository ?? new AssessmentRepository(options.pool);
  const assessmentService =
    options.assessmentService ??
    new AssessmentService({
      repository: assessmentRepository,
    });
  const evidenceRepository =
    options.evidenceRepository ?? new EvidenceRepository(options.pool);
  const evidenceStorage = options.evidenceStorage ?? new LocalEvidenceStorage();
  const evidenceService =
    options.evidenceService ??
    new EvidenceService({
      repository: evidenceRepository,
      storage: evidenceStorage,
    });
  const scoringRepository =
    options.scoringRepository ?? new ScoringRepository(options.pool);
  const scoringService =
    options.scoringService ??
    new ScoringService({
      repository: scoringRepository,
    });
  const submissionReadinessRepository =
    options.submissionReadinessRepository ??
    new SubmissionReadinessRepository(options.pool);
  const submissionReadinessService =
    options.submissionReadinessService ??
    new SubmissionReadinessService({
      repository: submissionReadinessRepository,
    });
  const submissionPackageRepository =
    options.submissionPackageRepository ??
    new SubmissionPackageRepository(options.pool);
  const submissionPackageService =
    options.submissionPackageService ??
    new SubmissionPackageService({
      repository: submissionPackageRepository,
    });
  const externalSubmissionRepository =
    options.externalSubmissionRepository ??
    new ExternalSubmissionRepository(options.pool);
  const pkcertIntakeRepository =
    options.pkcertIntakeRepository ?? new PkcertIntakeRepository(options.pool);
  const pkcertDecisionRepository =
    options.pkcertDecisionRepository ?? new PkcertDecisionRepository(options.pool);
  const correctionResubmissionRepository =
    options.correctionResubmissionRepository ??
    new CorrectionResubmissionRepository(options.pool);
  const correctionExecutionRepository =
    options.correctionExecutionRepository ??
    new CorrectionExecutionRepository(options.pool);
  const externalSubmissionService =
    options.externalSubmissionService ??
    new ExternalSubmissionService({
      repository: externalSubmissionRepository,
      pkcertIntakeRepository,
      pkcertDecisionRepository,
    });
  const pkcertIntakeService =
    options.pkcertIntakeService ??
    new PkcertIntakeService({
      repository: pkcertIntakeRepository,
    });
  const pkcertDecisionService =
    options.pkcertDecisionService ??
    new PkcertDecisionService({
      repository: pkcertDecisionRepository,
    });
  const correctionResubmissionService =
    options.correctionResubmissionService ??
    new CorrectionResubmissionService({
      repository: correctionResubmissionRepository,
    });
  const correctionExecutionService =
    options.correctionExecutionService ??
    new CorrectionExecutionService({
      repository: correctionExecutionRepository,
    });

  const requestMeta = (req: AuthenticatedRequest) => ({
    ipAddress: req.ip ?? null,
    userAgent: req.header("user-agent") ?? null,
  });

  app.post("/auth/register", async (req, res) => {
    try {
      const result = await withTransaction(
        options.pool,
        (tx) =>
          options.service.register(
            tx,
            {
              organizationName: String(req.body.organizationName ?? ""),
              email: String(req.body.email ?? ""),
              password: String(req.body.password ?? ""),
              role: req.body.role ? String(req.body.role) : undefined,
            },
            requestMeta(req as AuthenticatedRequest),
          ),
        options.txOverride,
      );
      res.status(201).json(result);
    } catch (err) {
      toHttpError(res, err);
    }
  });

  app.post("/auth/login", async (req, res) => {
    try {
      const loginInput = {
        orgId: String(req.body.orgId ?? ""),
        email: String(req.body.email ?? ""),
        password: String(req.body.password ?? ""),
      };
      const meta = requestMeta(req as AuthenticatedRequest);
      const [ipKey, userKey] = options.service.toLoginLimiterKeys(loginInput, meta);

      if (hardCutoff.checkLogin(ipKey, userKey)) {
        metrics.increment("hard_reject");
        throw AUTH_ERRORS.RATE_LIMITED();
      }

      try {
        options.service.precheckRateLimit("login_ip", ipKey);
        options.service.precheckRateLimit("login_user", userKey);
      } catch (err) {
        if (err instanceof AuthError && err.code === "RATE_LIMITED") {
          metrics.increment("soft_reject");
        }
        throw err;
      }

      try {
        await withTransaction(
          options.pool,
          async (tx) => {
            await options.service.consumeRateLimit(tx, "login_ip", ipKey);
            await options.service.consumeRateLimit(tx, "login_user", userKey);
          },
          options.txOverride,
        );
      } catch (err) {
        if (err instanceof AuthError && err.code === "RATE_LIMITED") {
          metrics.increment("db_reject");
        }
        throw err;
      }
      metrics.increment("db_pass");

      const result = await withTransaction(
        options.pool,
        (tx) => options.service.login(tx, loginInput, meta),
        options.txOverride,
      );
      res.status(200).json(result);
    } catch (err) {
      toHttpError(res, err);
    }
  });

  app.post("/auth/refresh", async (req, res) => {
    try {
      const refreshToken = String(req.body.refreshToken ?? "");
      const meta = requestMeta(req as AuthenticatedRequest);
      const claims = options.service.parseRefreshClaims(refreshToken);
      const refreshKeys = options.service.toRefreshLimiterKeys(claims, meta);

      if (hardCutoff.checkRefresh(refreshKeys.ip, refreshKeys.session)) {
        metrics.increment("hard_reject");
        throw AUTH_ERRORS.RATE_LIMITED();
      }

      try {
        options.service.precheckRateLimit("refresh_ip", refreshKeys.ip);
        options.service.precheckRateLimit("refresh_session", refreshKeys.session);
      } catch (err) {
        if (err instanceof AuthError && err.code === "RATE_LIMITED") {
          metrics.increment("soft_reject");
        }
        throw err;
      }

      try {
        await withTransaction(
          options.pool,
          async (tx) => {
            await options.service.consumeRateLimit(tx, "refresh_ip", refreshKeys.ip);
            await options.service.consumeRateLimit(tx, "refresh_session", refreshKeys.session);
          },
          options.txOverride,
        );
      } catch (err) {
        if (err instanceof AuthError && err.code === "RATE_LIMITED") {
          metrics.increment("db_reject");
        }
        throw err;
      }
      metrics.increment("db_pass");

      let attempt = 0;
      while (true) {
        try {
          const result = await withTransaction(
            options.pool,
            (tx) =>
              options.service.refresh(
                tx,
                { refreshToken },
                meta,
              ),
            options.txOverride,
          );
          res.status(200).json(result);
          return;
        } catch (err) {
          if (
            options.txOverride ||
            !(err instanceof TransactionExecutionError) ||
            !err.timeout ||
            !err.rollbackConfirmed ||
            err.commitAttempted ||
            attempt >= 1
          ) {
            if (err instanceof TransactionExecutionError && err.timeout) {
              throw AUTH_ERRORS.SERVICE_TEMPORARILY_UNAVAILABLE();
            }
            throw err;
          }
          attempt += 1;
        }
      }
    } catch (err) {
      toHttpError(res, err);
    }
  });

  app.post(
    "/auth/logout",
    requireAuth("TERMINATE_CURRENT_SESSION"),
    async (req, res) => {
      try {
        await withTransaction(
          options.pool,
          (tx) =>
            options.service.logout(tx, {
              claims: (req as AuthenticatedRequest).auth!,
            }),
          options.txOverride,
        );
        res.status(204).send();
      } catch (err) {
        toHttpError(res, err);
      }
    },
  );

  app.post(
    "/auth/logout-all",
    requireAuth("REVOKE_ALL_SESSIONS"),
    async (req, res) => {
      try {
        await withTransaction(
          options.pool,
          (tx) =>
            options.service.logoutAll(tx, {
              claims: (req as AuthenticatedRequest).auth!,
            }),
          options.txOverride,
        );
        res.status(204).send();
      } catch (err) {
        toHttpError(res, err);
      }
    },
  );

  app.get("/auth/me", requireAuth("READ_SELF_PROFILE"), async (req, res) => {
    try {
      const result = await withTransaction(
        options.pool,
        (tx) =>
          options.service.me(tx, {
            claims: (req as AuthenticatedRequest).auth!,
          }),
        options.txOverride,
      );
      res.status(200).json(result);
    } catch (err) {
      toHttpError(res, err);
    }
  });

  app.post(
    "/auth/admin/token-epoch/bump",
    requireAuth("BUMP_TOKEN_EPOCH"),
    async (req, res) => {
      try {
        const dryRun = `${req.query.dry_run ?? ""}`.toLowerCase() === "true";
        if (dryRun) {
          const result = await withTransaction(
            options.pool,
            (tx) =>
              options.service.previewTokenEpochBumpImpact(
                tx,
                (req as AuthenticatedRequest).auth!,
                String(req.body.reason ?? ""),
                requestMeta(req as AuthenticatedRequest),
              ),
            options.txOverride,
          );
          res.status(200).json(result);
          return;
        }

        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.requestTokenEpochBump(
              tx,
              (req as AuthenticatedRequest).auth!,
              String(req.body.reason ?? ""),
              requestMeta(req as AuthenticatedRequest),
            ),
          options.txOverride,
        );
        res.status(202).json(result);
      } catch (err) {
        if (
          err instanceof AuthError &&
          (err.code === "RATE_LIMITED" || err.code === "EPOCH_BUMP_RATE_LIMITED")
        ) {
          metrics.increment("db_reject");
        }
        toHttpError(res, err);
      }
    },
  );

  app.post(
    "/auth/admin/token-epoch/confirm",
    requireAuth("BUMP_TOKEN_EPOCH"),
    async (req, res) => {
      try {
        const result = await withTransaction(
          options.pool,
          (tx) =>
            options.service.confirmTokenEpochBump(
              tx,
              (req as AuthenticatedRequest).auth!,
              String(req.body.confirmationToken ?? ""),
              requestMeta(req as AuthenticatedRequest),
            ),
          options.txOverride,
        );
        res.status(200).json(result);
      } catch (err) {
        if (
          err instanceof AuthError &&
          (err.code === "RATE_LIMITED" || err.code === "EPOCH_BUMP_RATE_LIMITED")
        ) {
          metrics.increment("db_reject");
        }
        toHttpError(res, err);
      }
    },
  );

  app.get("/orgs/pending", requireAuth("ORG_LIST_PENDING"), async (req, res) => {
    try {
      const page = Number(req.query.page ?? 1);
      const pageSize = Number(req.query.pageSize ?? 25);
      const result = await withTransaction(
        options.pool,
        (tx) =>
          orgService.listPending(tx, (req as AuthenticatedRequest).auth!, {
            page,
            pageSize,
          }),
        options.txOverride,
      );
      res.status(200).json(result);
    } catch (err) {
      toHttpError(res, err);
    }
  });

  app.post(
    "/orgs/:orgId/approve",
    requireAuth("ORG_APPROVE"),
    async (req, res) => {
      try {
        const result = await withTransaction(
          options.pool,
          (tx) =>
            orgService.approve(
              tx,
              (req as AuthenticatedRequest).auth!,
              String(req.params.orgId ?? ""),
              String(req.body.reason ?? ""),
              requestMeta(req as AuthenticatedRequest),
            ),
          options.txOverride,
        );
        res.status(200).json(result);
      } catch (err) {
        toHttpError(res, err);
      }
    },
  );

  app.post(
    "/orgs/:orgId/reject",
    requireAuth("ORG_REJECT"),
    async (req, res) => {
      try {
        const result = await withTransaction(
          options.pool,
          (tx) =>
            orgService.reject(
              tx,
              (req as AuthenticatedRequest).auth!,
              String(req.params.orgId ?? ""),
              String(req.body.reason ?? ""),
              requestMeta(req as AuthenticatedRequest),
            ),
          options.txOverride,
        );
        res.status(200).json(result);
      } catch (err) {
        toHttpError(res, err);
      }
    },
  );

  app.post(
    "/orgs/:orgId/suspend",
    requireAuth("ORG_SUSPEND"),
    async (req, res) => {
      try {
        const result = await withTransaction(
          options.pool,
          (tx) =>
            orgService.suspend(
              tx,
              (req as AuthenticatedRequest).auth!,
              String(req.params.orgId ?? ""),
              String(req.body.reason ?? ""),
              requestMeta(req as AuthenticatedRequest),
            ),
          options.txOverride,
        );
        res.status(200).json(result);
      } catch (err) {
        toHttpError(res, err);
      }
    },
  );

  app.post(
    "/orgs/:orgId/reactivate",
    requireAuth("ORG_REACTIVATE"),
    async (req, res) => {
      try {
        const result = await withTransaction(
          options.pool,
          (tx) =>
            orgService.reactivate(
              tx,
              (req as AuthenticatedRequest).auth!,
              String(req.params.orgId ?? ""),
              String(req.body.reason ?? ""),
              requestMeta(req as AuthenticatedRequest),
            ),
          options.txOverride,
        );
        res.status(200).json(result);
      } catch (err) {
        toHttpError(res, err);
      }
    },
  );

  registerPisfRoutes({
    app,
    pool: options.pool,
    txOverride: options.txOverride,
    requireAuth,
    service: pisfService,
  });

  registerAssessmentRoutes({
    app,
    pool: options.pool,
    txOverride: options.txOverride,
    requireAuth,
    service: assessmentService,
  });

  registerEvidenceRoutes({
    app,
    pool: options.pool,
    txOverride: options.txOverride,
    requireAuth,
    service: evidenceService,
  });

  registerScoringRoutes({
    app,
    pool: options.pool,
    txOverride: options.txOverride,
    requireAuth,
    service: scoringService,
  });

  registerSubmissionReadinessRoutes({
    app,
    pool: options.pool,
    txOverride: options.txOverride,
    requireAuth,
    service: submissionReadinessService,
  });

  registerSubmissionPackageRoutes({
    app,
    pool: options.pool,
    txOverride: options.txOverride,
    requireAuth,
    service: submissionPackageService,
  });

  registerExternalSubmissionRoutes({
    app,
    pool: options.pool,
    txOverride: options.txOverride,
    requireAuth,
    service: externalSubmissionService,
  });

  registerPkcertIntakeRoutes({
    app,
    pool: options.pool,
    txOverride: options.txOverride,
    requireAuth,
    service: pkcertIntakeService,
  });

  registerPkcertDecisionRoutes({
    app,
    pool: options.pool,
    txOverride: options.txOverride,
    requireAuth,
    service: pkcertDecisionService,
  });

  registerCorrectionResubmissionRoutes({
    app,
    pool: options.pool,
    txOverride: options.txOverride,
    requireAuth,
    service: correctionResubmissionService,
  });

  registerCorrectionExecutionRoutes({
    app,
    pool: options.pool,
    txOverride: options.txOverride,
    requireAuth,
    service: correctionExecutionService,
  });

  return app;
}
