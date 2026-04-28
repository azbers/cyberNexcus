type GateRecord = {
  bucketStartMs: number;
  count: number;
};

type HardCutoffRules = {
  loginIpPerWindow: number;
  loginUserPerWindow: number;
  refreshIpPerWindow: number;
  refreshSessionPerWindow: number;
  windowMs: number;
};

type AuthRouteMetricName = "hard_reject" | "soft_reject" | "db_reject" | "db_pass";

const DEFAULT_RULES: HardCutoffRules = {
  loginIpPerWindow: 80,
  loginUserPerWindow: 40,
  refreshIpPerWindow: 200,
  refreshSessionPerWindow: 120,
  windowMs: 10_000,
};

export class HardCutoffGate {
  private readonly rules: HardCutoffRules;
  private readonly counters = new Map<string, GateRecord>();

  public constructor(rules?: Partial<HardCutoffRules>) {
    this.rules = { ...DEFAULT_RULES, ...(rules ?? {}) };
  }

  public checkLogin(ipKey: string, userKey: string, now = Date.now()): boolean {
    const ipBlocked = this.consume(`hard:login:ip:${ipKey}`, this.rules.loginIpPerWindow, now);
    if (ipBlocked) {
      return true;
    }
    return this.consume(`hard:login:user:${userKey}`, this.rules.loginUserPerWindow, now);
  }

  public checkRefresh(ipKey: string, sessionKey: string, now = Date.now()): boolean {
    const ipBlocked = this.consume(`hard:refresh:ip:${ipKey}`, this.rules.refreshIpPerWindow, now);
    if (ipBlocked) {
      return true;
    }
    return this.consume(
      `hard:refresh:session:${sessionKey}`,
      this.rules.refreshSessionPerWindow,
      now,
    );
  }

  private consume(counterKey: string, limit: number, nowMs: number): boolean {
    const bucketStartMs = Math.floor(nowMs / this.rules.windowMs) * this.rules.windowMs;
    const current = this.counters.get(counterKey);
    if (!current || current.bucketStartMs !== bucketStartMs) {
      this.counters.set(counterKey, { bucketStartMs, count: 1 });
      return 1 > limit;
    }

    current.count += 1;
    return current.count > limit;
  }
}

export class AuthRouteMetrics {
  private readonly counters = new Map<AuthRouteMetricName, number>([
    ["hard_reject", 0],
    ["soft_reject", 0],
    ["db_reject", 0],
    ["db_pass", 0],
  ]);

  public increment(metric: AuthRouteMetricName): void {
    const value = this.counters.get(metric) ?? 0;
    this.counters.set(metric, value + 1);
  }

  public snapshot(): Record<AuthRouteMetricName, number> {
    return {
      hard_reject: this.counters.get("hard_reject") ?? 0,
      soft_reject: this.counters.get("soft_reject") ?? 0,
      db_reject: this.counters.get("db_reject") ?? 0,
      db_pass: this.counters.get("db_pass") ?? 0,
    };
  }
}

export type { HardCutoffRules };
