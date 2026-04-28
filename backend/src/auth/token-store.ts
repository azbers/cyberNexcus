import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { TokenPair } from "./types.js";

type StoredIssuedTokens = {
  issued_access_token_ciphertext: string | null;
  issued_refresh_token_ciphertext: string | null;
};

export class TokenStore {
  private readonly key: Buffer;
  private readonly keyVersion: number;

  public constructor(keyHex: string, keyVersion = 1) {
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
      throw new Error("AUTH_TOKEN_STORE_KEY_HEX must be 64 hex characters");
    }
    this.key = Buffer.from(keyHex, "hex");
    this.keyVersion = keyVersion;
  }

  public getKeyVersion(): number {
    return this.keyVersion;
  }

  public encryptToken(token: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return `${iv.toString("hex")}.${tag.toString("hex")}.${encrypted.toString("hex")}`;
  }

  public decryptToken(payload: string): string {
    const [ivHex, tagHex, encryptedHex] = payload.split(".");
    if (!ivHex || !tagHex || !encryptedHex) {
      throw new Error("Invalid encrypted token payload");
    }

    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const encrypted = Buffer.from(encryptedHex, "hex");

    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  }

  public encryptTokenPair(pair: TokenPair): {
    issuedAccessTokenCiphertext: string;
    issuedRefreshTokenCiphertext: string;
    issuedTokensKeyVersion: number;
  } {
    return {
      issuedAccessTokenCiphertext: this.encryptToken(pair.accessToken),
      issuedRefreshTokenCiphertext: this.encryptToken(pair.refreshToken),
      issuedTokensKeyVersion: this.keyVersion,
    };
  }

  public decryptStoredTokenPair(record: StoredIssuedTokens): TokenPair {
    if (!record.issued_access_token_ciphertext || !record.issued_refresh_token_ciphertext) {
      throw new Error("Stored issued token payload is missing");
    }

    return {
      accessToken: this.decryptToken(record.issued_access_token_ciphertext),
      refreshToken: this.decryptToken(record.issued_refresh_token_ciphertext),
    };
  }
}
