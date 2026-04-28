import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileTypeFromBuffer } from "file-type";

import { AUTH_ERRORS } from "../auth/errors.js";

const ALLOWED_EXTENSIONS = new Set([
  "pdf",
  "docx",
  "xlsx",
  "png",
  "jpg",
  "jpeg",
  "txt",
  "csv",
]);

const EXTENSION_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  txt: "text/plain",
  csv: "text/csv",
};

type DetectedEvidenceType = {
  extension: string;
  mimeType: string;
};

type StoredFile = {
  storageKey: string;
  storedFilename: string;
};

type CreateStoredFileInput = {
  buffer: Buffer;
};

function normalizeExtension(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase().replace(/^\./, "");
  return ext;
}

function isLikelyText(buffer: Buffer): boolean {
  const scanLength = Math.min(buffer.length, 4096);
  if (scanLength === 0) {
    return false;
  }
  for (let i = 0; i < scanLength; i += 1) {
    const byte = buffer[i];
    if (byte === 0) {
      return false;
    }
  }
  return true;
}

function detectZipOfficeType(buffer: Buffer): DetectedEvidenceType | null {
  const marker = buffer.subarray(0, Math.min(buffer.length, 64 * 1024)).toString("latin1");
  if (marker.includes("word/")) {
    return {
      extension: "docx",
      mimeType: EXTENSION_TO_MIME.docx,
    };
  }
  if (marker.includes("xl/")) {
    return {
      extension: "xlsx",
      mimeType: EXTENSION_TO_MIME.xlsx,
    };
  }
  return null;
}

async function detectEvidenceType(
  buffer: Buffer,
  originalFilename: string,
): Promise<DetectedEvidenceType> {
  const extFromName = normalizeExtension(originalFilename);
  const inferred = await fileTypeFromBuffer(buffer);

  if (inferred) {
    const inferredExt = inferred.ext.toLowerCase();
    if (inferredExt === "zip") {
      const office = detectZipOfficeType(buffer);
      if (office) {
        return office;
      }
      throw AUTH_ERRORS.EVIDENCE_FILE_TYPE_NOT_ALLOWED();
    }
    if (ALLOWED_EXTENSIONS.has(inferredExt)) {
      return {
        extension: inferredExt,
        mimeType: inferred.mime,
      };
    }
    throw AUTH_ERRORS.EVIDENCE_FILE_TYPE_NOT_ALLOWED();
  }

  if ((extFromName === "txt" || extFromName === "csv") && isLikelyText(buffer)) {
    return {
      extension: extFromName,
      mimeType: EXTENSION_TO_MIME[extFromName],
    };
  }

  throw AUTH_ERRORS.EVIDENCE_FILE_TYPE_NOT_ALLOWED();
}

function toSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export class LocalEvidenceStorage {
  private readonly rootDir: string;

  public constructor(rootDir?: string) {
    const resolved =
      rootDir ??
      process.env.EVIDENCE_STORAGE_ROOT ??
      path.resolve(process.cwd(), "storage", "evidence");
    this.rootDir = path.resolve(resolved);

    const publicRoot = path.resolve(process.cwd(), "public");
    const staticRoot = path.resolve(process.cwd(), "static");
    if (
      this.isInside(publicRoot, this.rootDir) ||
      this.isInside(staticRoot, this.rootDir)
    ) {
      throw AUTH_ERRORS.EVIDENCE_STORAGE_PATH_INVALID();
    }
  }

  public async detectAndHash(
    buffer: Buffer,
    originalFilename: string,
  ): Promise<{
    detected: DetectedEvidenceType;
    extensionFromName: string;
    sha256Hash: string;
  }> {
    const detected = await detectEvidenceType(buffer, originalFilename);
    return {
      detected,
      extensionFromName: normalizeExtension(originalFilename),
      sha256Hash: toSha256(buffer),
    };
  }

  public async createStoredFile(input: CreateStoredFileInput): Promise<StoredFile> {
    const storageKey = randomUUID();
    const storedFilename = storageKey;
    const absolutePath = this.resolvePath(storageKey);

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.buffer, { flag: "wx" });

    return {
      storageKey,
      storedFilename,
    };
  }

  public async readFile(storageKey: string): Promise<Buffer> {
    const absolutePath = this.resolvePath(storageKey);
    return readFile(absolutePath);
  }

  public async removeFile(storageKey: string): Promise<void> {
    const absolutePath = this.resolvePath(storageKey);
    try {
      await unlink(absolutePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw err;
      }
    }
  }

  private resolvePath(storageKey: string): string {
    const normalized = storageKey.replace(/\\/g, "/");
    const absolute = path.resolve(this.rootDir, normalized);
    if (!this.isInside(this.rootDir, absolute)) {
      throw AUTH_ERRORS.EVIDENCE_STORAGE_PATH_INVALID();
    }
    return absolute;
  }

  private isInside(root: string, value: string): boolean {
    const normalizedRoot = path.resolve(root);
    const normalizedValue = path.resolve(value);
    return (
      normalizedValue === normalizedRoot ||
      normalizedValue.startsWith(`${normalizedRoot}${path.sep}`)
    );
  }
}

export type { DetectedEvidenceType, StoredFile };
