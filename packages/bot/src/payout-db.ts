import { getDb } from "@salesrecon/shared";
import type { PayoutVerdict } from "./payout-classify.js";

export type PayoutCheckRow = {
  guild_id: string;
  channel_id: string;
  requested_by: string;
  dicloak_profile_id: string;
  verdict: PayoutVerdict | "dry_run";
  reason: string;
  final_url: string;
  page_title: string;
  payout_hint: string | null;
};

/** Record one /payout-check outcome. Login-health fields only — never secrets. */
export function recordPayoutCheck(row: PayoutCheckRow): number {
  const result = getDb()
    .prepare(
      `INSERT INTO payout_checks
        (guild_id, channel_id, requested_by, dicloak_profile_id, verdict, reason, final_url, page_title, payout_hint)
       VALUES (@guild_id, @channel_id, @requested_by, @dicloak_profile_id, @verdict, @reason, @final_url, @page_title, @payout_hint)`,
    )
    .run({ ...row, payout_hint: row.payout_hint ?? null });
  return Number(result.lastInsertRowid);
}
