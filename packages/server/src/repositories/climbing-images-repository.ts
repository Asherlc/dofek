import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { listClimbingImages, signStoredImages } from "./activity-images-repository.ts";
import { postgresActivityCalendarDate } from "./activity-local-date.ts";

export class ClimbingImagesRepository extends BaseRepository {
  async getImages(
    id: string,
    storage: { sign(key: string): Promise<string>; readImage(key: string): Promise<Uint8Array> },
  ) {
    const [owner] = await this.query(
      z.object({ id: z.string() }),
      sql`
      SELECT entry.id FROM fitness.climbing_log_entry entry
      LEFT JOIN fitness.activity attached ON attached.id=entry.activity_id AND attached.user_id=entry.user_id
      LEFT JOIN fitness.v_activity grouped ON grouped.user_id=entry.user_id AND attached.id=ANY(grouped.member_activity_ids)
      WHERE entry.id=${id}::uuid AND entry.user_id=${this.userId}::uuid
        AND entry.provider_absent_at IS NULL
        AND (entry.activity_id IS NULL OR (attached.deleted_at IS NULL AND attached.provider_absent_at IS NULL AND attached.id IS NOT NULL))
        ${this.dateAccessPredicate(sql`CASE WHEN entry.activity_id IS NULL THEN entry.climbed_on ELSE ${postgresActivityCalendarDate(sql`grouped`, this.timezone)} END`)}
      LIMIT 1`,
    );
    if (!owner) throw new TRPCError({ code: "NOT_FOUND", message: "Climbing log entry not found" });
    return signStoredImages(
      await listClimbingImages(this.db, { userId: this.userId, climbingLogEntryId: owner.id }),
      storage,
      "climbing",
    );
  }
}
