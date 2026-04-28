import type { NextFunction, RequestHandler, Response } from "express";
import type { Pool, PoolClient } from "pg";

import { AuthError } from "./errors.js";
import { AuthRepository } from "./repository.js";
import { verifyToken } from "./tokens.js";
import type { AuthAction, AuthenticatedRequest } from "./types.js";

type MiddlewareOptions = {
  pool: Pool;
  repository: AuthRepository;
  jwtSecret: string;
  issuer?: string;
  txOverride?: PoolClient;
  now?: () => Date;
};

const DEFAULT_ISSUER = "core-backend-auth";
const ADMIN_ONLY_ACTIONS: AuthAction[] = [
  "BUMP_TOKEN_EPOCH",
  "ORG_LIST_PENDING",
  "ORG_APPROVE",
  "ORG_REJECT",
  "ORG_SUSPEND",
  "ORG_REACTIVATE",
  "ASSESSMENT_CREATE_DRAFT",
  "ASSESSMENT_FINALIZE_INTERNAL",
  "ASSESSMENT_SCORE_CALCULATE",
];

function unauthorized(response: Response): void {
  response.status(401).json({
    code: "UNAUTHORIZED",
    error: "Unauthorized",
  });
}

function sensitiveReauth(response: Response): void {
  response.status(403).json({
    code: "SENSITIVE_REAUTH_REQUIRED",
    error: "Sensitive action requires re-authentication",
  });
}

function forbiddenAction(response: Response): void {
  response.status(403).json({
    code: "FORBIDDEN_ACTION",
    error: "Forbidden action",
  });
}

export function createAuthMiddleware(options: MiddlewareOptions) {
  const issuer = options.issuer ?? DEFAULT_ISSUER;
  const now = options.now ?? (() => new Date());

  return function requireAuth(action: AuthAction): RequestHandler {
    return async function authMiddleware(
      request: AuthenticatedRequest,
      response: Response,
      next: NextFunction,
    ): Promise<void> {
      const authHeader = request.header("authorization");
      const accessToken =
        authHeader && authHeader.startsWith("Bearer ")
          ? authHeader.slice("Bearer ".length).trim()
          : null;

      if (!accessToken) {
        unauthorized(response);
        return;
      }

      const claims = verifyToken(accessToken, "access", {
        jwtSecret: options.jwtSecret,
        issuer,
      });
      if (!claims) {
        unauthorized(response);
        return;
      }

      const client = options.txOverride ?? (await options.pool.connect());
      try {
        const context = await options.repository.findSessionAuthContext(client, claims.sessionId);
        if (!context) {
          unauthorized(response);
          return;
        }

        if (
          context.user_id !== claims.userId ||
          context.org_id !== claims.orgId ||
          context.session_id !== claims.sessionId ||
          context.session_family_id !== claims.sessionFamilyId
        ) {
          unauthorized(response);
          return;
        }

        if (
          context.user_token_version !== claims.tokenVersion ||
          context.org_status !== "APPROVED" ||
          !context.email_verified ||
          context.user_deactivated_at
        ) {
          unauthorized(response);
          return;
        }

        if (claims.iat * 1000 < context.token_epoch.getTime()) {
          unauthorized(response);
          return;
        }

        if (
          context.revoked_at ||
          context.absolute_expires_at <= now() ||
          context.idle_expires_at <= now()
        ) {
          unauthorized(response);
          return;
        }

        const sensitiveAction = action === "ROTATE_SESSION" || action === "REVOKE_ALL_SESSIONS";
        if (sensitiveAction && context.sensitive_reauth_required) {
          sensitiveReauth(response);
          return;
        }

        if (ADMIN_ONLY_ACTIONS.includes(action) && context.user_role !== "admin") {
          forbiddenAction(response);
          return;
        }

        request.auth = claims;
        next();
      } catch (err) {
        next(err);
      } finally {
        if (!options.txOverride) {
          client.release();
        }
      }
    };
  };
}

export function toHttpError(response: Response, err: unknown): void {
  if (err instanceof AuthError) {
    response.status(err.statusCode).json({
      code: err.code,
      error: err.message,
    });
    return;
  }
  unauthorized(response);
}
