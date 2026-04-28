import { describe, expect, it } from "vitest";

import { scoreLabelFor } from "../src/scoring/service.js";

describe("scoreLabelFor", () => {
  it("uses deterministic label boundaries", () => {
    expect(scoreLabelFor(null)).toBeNull();
    expect(scoreLabelFor(0)).toBe("NON_COMPLIANT");
    expect(scoreLabelFor(49.99)).toBe("NON_COMPLIANT");
    expect(scoreLabelFor(50)).toBe("PARTIALLY_COMPLIANT");
    expect(scoreLabelFor(69.99)).toBe("PARTIALLY_COMPLIANT");
    expect(scoreLabelFor(70)).toBe("SUBSTANTIALLY_COMPLIANT");
    expect(scoreLabelFor(89.99)).toBe("SUBSTANTIALLY_COMPLIANT");
    expect(scoreLabelFor(90)).toBe("COMPLIANT");
    expect(scoreLabelFor(100)).toBe("COMPLIANT");
  });
});
