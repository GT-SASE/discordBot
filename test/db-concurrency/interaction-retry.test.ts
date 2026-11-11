import { describe, expect, it } from "vitest";
import { fakeId } from "../db/harness.ts";
import { raceDatabase } from "./race.ts";

/** Discord sends the same interaction again while the first delivery is still running. */
describe("a retried interaction", () => {
  const db = raceDatabase();
  const claimSql = "SELECT public.claim_interaction($1) AS claimed";

  it("is handled by only one of the two deliveries", async () => {
    const claim: [string, unknown[]] = [claimSql, [fakeId()]];
    const second = await db.race(claim, claim);
    expect(second.rows).toEqual([{ claimed: false }]);
  });

  it("is handled by the retry if the first delivery's claim rolls back", async () => {
    const claim: [string, unknown[]] = [claimSql, [fakeId()]];
    const second = await db.race(claim, claim, "ROLLBACK");
    expect(second.rows).toEqual([{ claimed: true }]);
  });
});
