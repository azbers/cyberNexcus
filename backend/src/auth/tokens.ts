import { createHash, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";

import type { AuthClaims, AuthTokenKind, TokenPair } from "./types.js";

type BaseClaims = Omit<AuthClaims, "tokenKind" | "iat" | "exp">;

type IssueOptions = {
  jwtSecret: string;
  issuer: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
};

type VerifyOptions = {
  jwtSecret: string;
  issuer: string;
};

type JwtPayloadShape = {
  sub: string;
  orgId: string;
  sessionId: string;
  sessionFamilyId: string;
  tokenVersion: number;
  tokenKind: AuthTokenKind;
  iat: number;
  exp: number;
};

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function normalizeIpPrefix(ipAddress: string | null): string {
  if (!ipAddress || ipAddress.trim().length === 0) {
    return "unknown";
  }
  const ip = ipAddress.trim().toLowerCase();
  if (ip.includes(":")) {
    const segments = ip.split(":").filter((segment) => segment.length > 0);
    return `v6:${segments.slice(0, 4).join(":")}`;
  }
  const segments = ip.split(".");
  if (segments.length !== 4) {
    return "unknown";
  }
  return `v4:${segments.slice(0, 3).join(".")}`;
}

function normalizeUserAgent(userAgent: string | null): string {
  if (!userAgent || userAgent.trim().length === 0) {
    return "unknown";
  }
  return userAgent.trim().toLowerCase();
}

export function hashDeviceContext(userAgent: string | null, ipAddress: string | null): string {
  const fingerprint = `${normalizeUserAgent(userAgent)}|${normalizeIpPrefix(ipAddress)}`;
  return createHash("sha256").update(fingerprint, "utf8").digest("hex");
}

export function timingSafeTokenHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  const maxLength = Math.max(leftBuffer.length, rightBuffer.length, 1);

  const normalizedLeft =
    leftBuffer.length === maxLength
      ? leftBuffer
      : Buffer.concat([leftBuffer, Buffer.alloc(maxLength - leftBuffer.length, 0)]);
  const normalizedRight =
    rightBuffer.length === maxLength
      ? rightBuffer
      : Buffer.concat([rightBuffer, Buffer.alloc(maxLength - rightBuffer.length, 0)]);

  const equal = timingSafeEqual(normalizedLeft, normalizedRight);
  return equal && leftBuffer.length === rightBuffer.length;
}

export function issueTokenPair(baseClaims: BaseClaims, options: IssueOptions): TokenPair {
  const accessToken = jwt.sign(
    {
      orgId: baseClaims.orgId,
      sessionId: baseClaims.sessionId,
      sessionFamilyId: baseClaims.sessionFamilyId,
      tokenVersion: baseClaims.tokenVersion,
      tokenKind: "access",
    },
    options.jwtSecret,
    {
      algorithm: "HS256",
      issuer: options.issuer,
      subject: baseClaims.userId,
      expiresIn: options.accessTtlSeconds,
    },
  );

  const refreshToken = jwt.sign(
    {
      orgId: baseClaims.orgId,
      sessionId: baseClaims.sessionId,
      sessionFamilyId: baseClaims.sessionFamilyId,
      tokenVersion: baseClaims.tokenVersion,
      tokenKind: "refresh",
    },
    options.jwtSecret,
    {
      algorithm: "HS256",
      issuer: options.issuer,
      subject: baseClaims.userId,
      expiresIn: options.refreshTtlSeconds,
    },
  );

  return { accessToken, refreshToken };
}

export function verifyToken(
  token: string,
  expectedKind: AuthTokenKind,
  options: VerifyOptions,
): AuthClaims | null {
  try {
    const decoded = jwt.verify(token, options.jwtSecret, {
      algorithms: ["HS256"],
      issuer: options.issuer,
    }) as JwtPayloadShape;

    if (decoded.tokenKind !== expectedKind) {
      return null;
    }

    return {
      userId: String(decoded.sub),
      orgId: decoded.orgId,
      sessionId: decoded.sessionId,
      sessionFamilyId: decoded.sessionFamilyId,
      tokenVersion: Number(decoded.tokenVersion),
      tokenKind: decoded.tokenKind,
      iat: Number(decoded.iat),
      exp: Number(decoded.exp),
    };
  } catch {
    return null;
  }
}
