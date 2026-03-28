import { randomBytes } from "node:crypto";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

export interface SharedReportRow {
	id: string;
	shareToken: string;
	reportType: string;
	reportData: unknown;
	expiresAt: string | null;
	createdAt: string;
}

export interface ReportListRow {
	id: string;
	shareToken: string;
	reportType: string;
	expiresAt: string | null;
	createdAt: string;
}

/** A shared health report with full detail (including report data). */
export class SharedReport {
	readonly #row: SharedReportRow;

	constructor(row: SharedReportRow) {
		this.#row = row;
	}

	get id(): string {
		return this.#row.id;
	}

	get shareToken(): string {
		return this.#row.shareToken;
	}

	get reportType(): string {
		return this.#row.reportType;
	}

	get reportData(): unknown {
		return this.#row.reportData;
	}

	get expiresAt(): string | null {
		return this.#row.expiresAt;
	}

	get createdAt(): string {
		return this.#row.createdAt;
	}

	toDetail() {
		return { ...this.#row };
	}
}

/** A report list entry (no report data payload). */
export class ReportListEntry {
	readonly #row: ReportListRow;

	constructor(row: ReportListRow) {
		this.#row = row;
	}

	get id(): string {
		return this.#row.id;
	}

	get shareToken(): string {
		return this.#row.shareToken;
	}

	get reportType(): string {
		return this.#row.reportType;
	}

	get expiresAt(): string | null {
		return this.#row.expiresAt;
	}

	get createdAt(): string {
		return this.#row.createdAt;
	}

	toDetail() {
		return { ...this.#row };
	}
}

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const sharedReportDbSchema = z.object({
	id: z.string(),
	share_token: z.string(),
	report_type: z.string(),
	report_data: z.unknown(),
	expires_at: timestampStringSchema.nullable(),
	created_at: timestampStringSchema,
});

const reportListDbSchema = z.object({
	id: z.string(),
	share_token: z.string(),
	report_type: z.string(),
	expires_at: timestampStringSchema.nullable(),
	created_at: timestampStringSchema,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a URL-safe share token. */
export function generateShareToken(): string {
	return randomBytes(24).toString("base64url");
}

function toSharedReport(row: z.infer<typeof sharedReportDbSchema>): SharedReport {
	return new SharedReport({
		id: row.id,
		shareToken: row.share_token,
		reportType: row.report_type,
		reportData: row.report_data,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
	});
}

function toReportListEntry(row: z.infer<typeof reportListDbSchema>): ReportListEntry {
	return new ReportListEntry({
		id: row.id,
		shareToken: row.share_token,
		reportType: row.report_type,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
	});
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for shared health reports. */
export class HealthReportRepository {
	readonly #db: Pick<Database, "execute">;
	readonly #userId: string;

	constructor(db: Pick<Database, "execute">, userId: string) {
		this.#db = db;
		this.#userId = userId;
	}

	/** Generate a new shareable health report. */
	async generate(
		reportType: string,
		reportData: Record<string, unknown>,
		expiresInDays: number | null,
	): Promise<SharedReport | null> {
		const token = generateShareToken();
		const expiresAt =
			expiresInDays != null
				? sql`NOW() + (${expiresInDays}::int || ' days')::interval`
				: sql`NULL`;

		const rows = await executeWithSchema(
			this.#db,
			sharedReportDbSchema,
			sql`INSERT INTO fitness.shared_report (user_id, share_token, report_type, report_data, expires_at)
				VALUES (${this.#userId}, ${token}, ${reportType}, ${JSON.stringify(reportData)}::jsonb, ${expiresAt})
				RETURNING id, share_token, report_type, report_data, expires_at, created_at`,
		);

		const row = rows[0];
		if (!row) return null;
		return toSharedReport(row);
	}

	/** List the current user's shared reports (newest first, max 50). */
	async myReports(): Promise<ReportListEntry[]> {
		const rows = await executeWithSchema(
			this.#db,
			reportListDbSchema,
			sql`SELECT id, share_token, report_type, expires_at, created_at
				FROM fitness.shared_report
				WHERE user_id = ${this.#userId}
				ORDER BY created_at DESC
				LIMIT 50`,
		);

		return rows.map(toReportListEntry);
	}

	/** Get a shared report by token — anyone with the link can view (public). */
	static async getShared(
		db: Pick<Database, "execute">,
		token: string,
	): Promise<SharedReport | null> {
		const rows = await executeWithSchema(
			db,
			sharedReportDbSchema,
			sql`SELECT id, share_token, report_type, report_data, expires_at, created_at
				FROM fitness.shared_report
				WHERE share_token = ${token}
				  AND (expires_at IS NULL OR expires_at > NOW())`,
		);

		const row = rows[0];
		if (!row) return null;
		return toSharedReport(row);
	}
}
