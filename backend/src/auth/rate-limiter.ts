type BlockEntry = {
  blockedUntilMs: number;
};

export class SoftMemoryRateLimiter {
  private readonly blocked = new Map<string, BlockEntry>();

  public isBlocked(key: string, now = new Date()): boolean {
    const entry = this.blocked.get(key);
    if (!entry) {
      return false;
    }

    if (entry.blockedUntilMs <= now.getTime()) {
      this.blocked.delete(key);
      return false;
    }

    return true;
  }

  public markBlocked(key: string, blockedUntil: Date): void {
    this.blocked.set(key, { blockedUntilMs: blockedUntil.getTime() });
  }
}
