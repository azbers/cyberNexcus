import type { PoolClient } from "pg";

import { AUTH_ERRORS } from "../auth/errors.js";

export type CorrectionGuardCycle = {
  id: string;
  cycle_type?: string | null;
};

export async function assertCorrectionExecutionActiveForCycle(
  tx: PoolClient,
  cycle: CorrectionGuardCycle,
): Promise<void> {
  if (cycle.cycle_type !== "CORRECTION") {
    return;
  }

  const result = await tx.query<{ exists: boolean }>(
    `
    SELECT EXISTS (
      SELECT 1
      FROM correction_execution_cycles
      WHERE correction_assessment_cycle_id = $1
        AND status = 'CREATED'
    ) AS exists
    `,
    [cycle.id],
  );

  if (!result.rows[0]?.exists) {
    throw AUTH_ERRORS.CORRECTION_EXECUTION_VOIDED();
  }
}
