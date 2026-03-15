import type { Database } from "../db/index.ts";
import { bodyMeasurement, dailyMetrics, metricStream, sleepSession } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import type { Provider, ProviderAuthSetup, SyncError, SyncResult } from "./types.ts";

// ============================================================
// Eight Sleep API types (reverse-engineered)
// ============================================================

const AUTH_API_BASE = "https://auth-api.8slp.net/v1";
const CLIENT_API_BASE = "https://client-api.8slp.net/v1";

// Hardcoded client credentials extracted from the Eight Sleep Android app
const EIGHT_SLEEP_CLIENT_ID = "0894c7f33bb94800a03f1f4df13a4f38";
const EIGHT_SLEEP_CLIENT_SECRET =
	"f0954a3ed5763ba3d06834c73731a32f15f168f47d4f164751275def86db0c76";

interface EightSleepAuthResponse {
	access_token: string;
	expires_in: number;
	userId: string;
}

interface EightSleepSleepQualityScore {
	total: number;
	hrv?: { score: number; current: number; average: number };
	respiratoryRate?: { score: number; current: number; average: number };
	heartRate?: { score: number; current: number; average: number };
	tempBedC?: { average: number };
	tempRoomC?: { average: number };
	sleepDurationSeconds?: { score: number };
}

interface EightSleepSleepStage {
	stage: string; // "awake" | "light" | "deep" | "rem" | "out"
	duration: number; // seconds
}

interface EightSleepTimeseries {
	heartRate?: Array<[string, number]>;
	tempBedC?: Array<[string, number]>;
	tempRoomC?: Array<[string, number]>;
	respiratoryRate?: Array<[string, number]>;
	hrv?: Array<[string, number]>;
}

interface EightSleepSession {
	stages: EightSleepSleepStage[];
	timeseries: EightSleepTimeseries;
}

interface EightSleepTrendDay {
	day: string; // "YYYY-MM-DD"
	score: number;
	tnt: number; // toss & turns
	processing: boolean;
	presenceDuration: number; // seconds
	sleepDuration: number;
	lightDuration: number;
	deepDuration: number;
	remDuration: number;
	latencyAsleepSeconds: number;
	latencyOutSeconds: number;
	presenceStart: string; // ISO datetime
	presenceEnd: string; // ISO datetime
	sleepQualityScore?: EightSleepSleepQualityScore;
	sleepRoutineScore?: {
		total: number;
		latencyAsleepSeconds?: { score: number };
		latencyOutSeconds?: { score: number };
		wakeupConsistency?: { score: number };
	};
	sleepFitnessScore?: { total: number };
	sessions?: EightSleepSession[];
}

interface EightSleepTrendsResponse {
	days: EightSleepTrendDay[];
}

// ============================================================
// Parsed types
// ============================================================

export interface ParsedEightSleepSession {
	externalId: string;
	startedAt: Date;
	endedAt: Date;
	durationMinutes: number;
	deepMinutes: number;
	remMinutes: number;
	lightMinutes: number;
	awakeMinutes: number;
	efficiencyPct: number;
	isNap: boolean;
}

export interface ParsedEightSleepDailyMetrics {
	date: string;
	restingHr?: number;
	hrv?: number;
	respiratoryRateAvg?: number;
	skinTempC?: number;
}

export interface ParsedEightSleepHrSample {
	recordedAt: Date;
	heartRate: number;
}

// ============================================================
// Parsing — pure functions
// ============================================================

function secondsToMinutes(seconds: number): number {
	return Math.round(seconds / 60);
}

export function parseEightSleepTrendDay(day: EightSleepTrendDay): ParsedEightSleepSession {
	const totalSleepSeconds = day.sleepDuration;
	const totalInBedSeconds = day.presenceDuration;
	const efficiency =
		totalInBedSeconds > 0 ? Math.round((totalSleepSeconds / totalInBedSeconds) * 100) : 0;

	return {
		externalId: `eightsleep-${day.day}`,
		startedAt: new Date(day.presenceStart),
		endedAt: new Date(day.presenceEnd),
		durationMinutes: secondsToMinutes(totalSleepSeconds),
		deepMinutes: secondsToMinutes(day.deepDuration),
		remMinutes: secondsToMinutes(day.remDuration),
		lightMinutes: secondsToMinutes(day.lightDuration),
		awakeMinutes: secondsToMinutes(day.presenceDuration - day.sleepDuration),
		efficiencyPct: efficiency,
		isNap: false,
	};
}

export function parseEightSleepDailyMetrics(
	day: EightSleepTrendDay,
): ParsedEightSleepDailyMetrics {
	const quality = day.sleepQualityScore;
	return {
		date: day.day,
		restingHr: quality?.heartRate?.current,
		hrv: quality?.hrv?.current,
		respiratoryRateAvg: quality?.respiratoryRate?.current,
		skinTempC: quality?.tempBedC?.average,
	};
}

export function parseEightSleepHeartRateSamples(
	sessions: EightSleepSession[],
): ParsedEightSleepHrSample[] {
	const samples: ParsedEightSleepHrSample[] = [];
	for (const session of sessions) {
		const hrSeries = session.timeseries?.heartRate;
		if (!hrSeries) continue;
		for (const [timestamp, bpm] of hrSeries) {
			if (bpm > 0) {
				samples.push({ recordedAt: new Date(timestamp), heartRate: Math.round(bpm) });
			}
		}
	}
	return samples;
}

// ============================================================
// Eight Sleep API client
// ============================================================

export class EightSleepClient {
	private accessToken: string;
	private userId: string;
	private fetchFn: typeof globalThis.fetch;

	constructor(
		accessToken: string,
		userId: string,
		fetchFn: typeof globalThis.fetch = globalThis.fetch,
	) {
		this.accessToken = accessToken;
		this.userId = userId;
		this.fetchFn = fetchFn;
	}

	private async get<T>(baseUrl: string, path: string): Promise<T> {
		const url = `${baseUrl}${path}`;
		const response = await this.fetchFn(url, {
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
				"Content-Type": "application/json",
				"User-Agent": "okhttp/4.9.3",
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Eight Sleep API error (${response.status}): ${text}`);
		}

		return response.json() as Promise<T>;
	}

	async getTrends(
		timezone: string,
		fromDate: string,
		toDate: string,
	): Promise<EightSleepTrendsResponse> {
		const params = new URLSearchParams({
			tz: timezone,
			from: fromDate,
			to: toDate,
			"include-main": "false",
			"include-all-sessions": "true",
			"model-version": "v2",
		});
		return this.get<EightSleepTrendsResponse>(
			CLIENT_API_BASE,
			`/users/${this.userId}/trends?${params}`,
		);
	}

	static async signIn(
		email: string,
		password: string,
		fetchFn: typeof globalThis.fetch = globalThis.fetch,
	): Promise<{ accessToken: string; expiresIn: number; userId: string }> {
		const response = await fetchFn(`${AUTH_API_BASE}/tokens`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_id: EIGHT_SLEEP_CLIENT_ID,
				client_secret: EIGHT_SLEEP_CLIENT_SECRET,
				grant_type: "password",
				username: email,
				password,
			}),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Eight Sleep sign-in failed (${response.status}): ${text}`);
		}

		const data = (await response.json()) as EightSleepAuthResponse;
		return {
			accessToken: data.access_token,
			expiresIn: data.expires_in,
			userId: data.userId,
		};
	}
}

// ============================================================
// Helper: format date as YYYY-MM-DD
// ============================================================

function formatDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

// ============================================================
// Provider implementation
// ============================================================

export class EightSleepProvider implements Provider {
	readonly id = "eight-sleep";
	readonly name = "Eight Sleep";
	private fetchFn: typeof globalThis.fetch;

	constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
		this.fetchFn = fetchFn;
	}

	validate(): string | null {
		// Eight Sleep is always "enabled" — auth state checked at sync time via stored tokens
		return null;
	}

	authSetup(): ProviderAuthSetup {
		const fetchFn = this.fetchFn;
		return {
			oauthConfig: {
				clientId: EIGHT_SLEEP_CLIENT_ID,
				clientSecret: EIGHT_SLEEP_CLIENT_SECRET,
				authorizeUrl: `${AUTH_API_BASE}/tokens`,
				tokenUrl: `${AUTH_API_BASE}/tokens`,
				redirectUri: "",
				scopes: [],
			},
			automatedLogin: async (email: string, password: string) => {
				const result = await EightSleepClient.signIn(email, password, fetchFn);
				return {
					accessToken: result.accessToken,
					refreshToken: null,
					expiresAt: new Date(Date.now() + result.expiresIn * 1000),
					scopes: `userId:${result.userId}`,
				};
			},
			exchangeCode: async () => {
				throw new Error("Eight Sleep uses automated login, not OAuth code exchange");
			},
		};
	}

	async sync(db: Database, since: Date): Promise<SyncResult> {
		const start = Date.now();
		const errors: SyncError[] = [];
		let recordsSynced = 0;

		await ensureProvider(db, this.id, this.name);

		// Resolve tokens — re-authenticate if expired (no refresh tokens)
		let client: EightSleepClient;
		try {
			const stored = await loadTokens(db, this.id);
			if (!stored) {
				throw new Error("Eight Sleep not connected — authenticate via the web UI");
			}

			const userIdMatch = stored.scopes?.match(/userId:(\S+)/);
			const userId = userIdMatch?.[1];
			if (!userId) {
				throw new Error("Eight Sleep user ID not found — re-authenticate");
			}

			// Re-authenticate if token expired (Eight Sleep has no refresh tokens)
			if (stored.expiresAt <= new Date()) {
				const email = process.env.EIGHT_SLEEP_USERNAME;
				const password = process.env.EIGHT_SLEEP_PASSWORD;
				if (!email || !password) {
					throw new Error(
						"Eight Sleep token expired and EIGHT_SLEEP_USERNAME/EIGHT_SLEEP_PASSWORD not set for re-auth",
					);
				}
				console.log("[eight-sleep] Token expired, re-authenticating...");
				const result = await EightSleepClient.signIn(email, password, this.fetchFn);
				const tokens = {
					accessToken: result.accessToken,
					refreshToken: null,
					expiresAt: new Date(Date.now() + result.expiresIn * 1000),
					scopes: `userId:${result.userId}`,
				};
				await saveTokens(db, this.id, tokens);
				client = new EightSleepClient(result.accessToken, result.userId, this.fetchFn);
			} else {
				client = new EightSleepClient(stored.accessToken, userId, this.fetchFn);
			}
		} catch (err) {
			errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
			return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
		}

		const sinceDate = formatDate(since);
		const toDate = formatDate(new Date());
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

		// Fetch trends (sleep data)
		let trendDays: EightSleepTrendDay[] = [];
		try {
			const trends = await client.getTrends(timezone, sinceDate, toDate);
			trendDays = trends.days.filter((d) => !d.processing);
		} catch (err) {
			errors.push({
				message: `getTrends: ${err instanceof Error ? err.message : String(err)}`,
				cause: err,
			});
			return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
		}

		// 1. Sync sleep sessions
		try {
			const sleepCount = await withSyncLog(db, this.id, "sleep", async () => {
				let count = 0;
				for (const day of trendDays) {
					if (!day.presenceStart || !day.presenceEnd) continue;
					const parsed = parseEightSleepTrendDay(day);
					try {
						await db
							.insert(sleepSession)
							.values({
								providerId: this.id,
								externalId: parsed.externalId,
								startedAt: parsed.startedAt,
								endedAt: parsed.endedAt,
								durationMinutes: parsed.durationMinutes,
								deepMinutes: parsed.deepMinutes,
								remMinutes: parsed.remMinutes,
								lightMinutes: parsed.lightMinutes,
								awakeMinutes: parsed.awakeMinutes,
								efficiencyPct: parsed.efficiencyPct,
								isNap: parsed.isNap,
							})
							.onConflictDoUpdate({
								target: [sleepSession.providerId, sleepSession.externalId],
								set: {
									startedAt: parsed.startedAt,
									endedAt: parsed.endedAt,
									durationMinutes: parsed.durationMinutes,
									deepMinutes: parsed.deepMinutes,
									remMinutes: parsed.remMinutes,
									lightMinutes: parsed.lightMinutes,
									awakeMinutes: parsed.awakeMinutes,
									efficiencyPct: parsed.efficiencyPct,
								},
							});
						count++;
					} catch (err) {
						errors.push({
							message: err instanceof Error ? err.message : String(err),
							externalId: parsed.externalId,
							cause: err,
						});
					}
				}
				return { recordCount: count, result: count };
			});
			recordsSynced += sleepCount;
		} catch (err) {
			errors.push({
				message: `sleep: ${err instanceof Error ? err.message : String(err)}`,
				cause: err,
			});
		}

		// 2. Sync daily metrics (HRV, resting HR, respiratory rate, bed temp)
		try {
			const dailyCount = await withSyncLog(db, this.id, "daily_metrics", async () => {
				let count = 0;
				for (const day of trendDays) {
					const parsed = parseEightSleepDailyMetrics(day);
					// Skip if no quality data
					if (!parsed.restingHr && !parsed.hrv && !parsed.respiratoryRateAvg) continue;
					try {
						await db
							.insert(dailyMetrics)
							.values({
								date: parsed.date,
								providerId: this.id,
								restingHr: parsed.restingHr ? Math.round(parsed.restingHr) : undefined,
								hrv: parsed.hrv,
								respiratoryRateAvg: parsed.respiratoryRateAvg,
								skinTempC: parsed.skinTempC,
							})
							.onConflictDoUpdate({
								target: [dailyMetrics.date, dailyMetrics.providerId],
								set: {
									restingHr: parsed.restingHr ? Math.round(parsed.restingHr) : undefined,
									hrv: parsed.hrv,
									respiratoryRateAvg: parsed.respiratoryRateAvg,
									skinTempC: parsed.skinTempC,
								},
							});
						count++;
					} catch (err) {
						errors.push({
							message: `daily ${parsed.date}: ${err instanceof Error ? err.message : String(err)}`,
							cause: err,
						});
					}
				}
				return { recordCount: count, result: count };
			});
			recordsSynced += dailyCount;
		} catch (err) {
			errors.push({
				message: `daily_metrics: ${err instanceof Error ? err.message : String(err)}`,
				cause: err,
			});
		}

		// 3. Sync body temperature as body measurements
		try {
			const bodyCount = await withSyncLog(db, this.id, "body_measurement", async () => {
				let count = 0;
				for (const day of trendDays) {
					const roomTemp = day.sleepQualityScore?.tempRoomC?.average;
					const bedTemp = day.sleepQualityScore?.tempBedC?.average;
					if (!roomTemp && !bedTemp) continue;

					const externalId = `eightsleep-temp-${day.day}`;
					try {
						await db
							.insert(bodyMeasurement)
							.values({
								providerId: this.id,
								externalId,
								recordedAt: new Date(day.presenceStart || `${day.day}T00:00:00Z`),
								temperatureC: bedTemp,
							})
							.onConflictDoUpdate({
								target: [bodyMeasurement.providerId, bodyMeasurement.externalId],
								set: { temperatureC: bedTemp },
							});
						count++;
					} catch (err) {
						errors.push({
							message: err instanceof Error ? err.message : String(err),
							externalId,
							cause: err,
						});
					}
				}
				return { recordCount: count, result: count };
			});
			recordsSynced += bodyCount;
		} catch (err) {
			errors.push({
				message: `body_measurement: ${err instanceof Error ? err.message : String(err)}`,
				cause: err,
			});
		}

		// 4. Sync HR time series from sessions
		try {
			const hrCount = await withSyncLog(db, this.id, "hr_stream", async () => {
				let totalRecords = 0;
				const BATCH_SIZE = 500;

				for (const day of trendDays) {
					if (!day.sessions?.length) continue;
					const samples = parseEightSleepHeartRateSamples(day.sessions);
					if (samples.length === 0) continue;

					for (let i = 0; i < samples.length; i += BATCH_SIZE) {
						const batch = samples.slice(i, i + BATCH_SIZE);
						await db
							.insert(metricStream)
							.values(
								batch.map((s) => ({
									providerId: this.id,
									recordedAt: s.recordedAt,
									heartRate: s.heartRate,
								})),
							)
							.onConflictDoNothing();
					}
					totalRecords += samples.length;
				}

				return { recordCount: totalRecords, result: totalRecords };
			});
			recordsSynced += hrCount;
		} catch (err) {
			errors.push({
				message: `hr_stream: ${err instanceof Error ? err.message : String(err)}`,
				cause: err,
			});
		}

		return {
			provider: this.id,
			recordsSynced,
			errors,
			duration: Date.now() - start,
		};
	}
}
