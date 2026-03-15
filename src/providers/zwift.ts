import type { Database } from "../db/index.ts";
import { activity, dailyMetrics, metricStream } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import type { Provider, ProviderAuthSetup, SyncError, SyncResult } from "./types.ts";

// ============================================================
// Zwift API types (reverse-engineered)
// ============================================================

const ZWIFT_AUTH_URL = "https://secure.zwift.com/auth/realms/zwift/protocol/openid-connect/token";
const ZWIFT_API_BASE = "https://us-or-rly101.zwift.com";

// ============================================================
// API response types
// ============================================================

interface ZwiftTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	token_type: string;
}

interface ZwiftProfile {
	id: number;
	firstName: string;
	lastName: string;
	ftp: number;
	weight: number; // grams
	height: number; // cm
}

interface ZwiftActivitySummary {
	id: number;
	id_str: string;
	profileId: number;
	name: string;
	startDate: string; // ISO
	endDate: string; // ISO
	distanceInMeters: number;
	avgHeartRate: number;
	maxHeartRate: number;
	avgWatts: number;
	maxWatts: number;
	avgCadenceInRotationsPerMinute: number;
	avgSpeedInMetersPerSecond: number;
	maxSpeedInMetersPerSecond: number;
	totalElevationInMeters: number;
	calories: number;
	sport: string; // "CYCLING", "RUNNING"
	rideOnGiven: number;
	activityRideOnCount: number;
}

interface ZwiftActivityDetail {
	id: number;
	id_str: string;
	profileId: number;
	name: string;
	startDate: string;
	endDate: string;
	distanceInMeters: number;
	avgHeartRate: number;
	maxHeartRate: number;
	avgWatts: number;
	maxWatts: number;
	avgCadenceInRotationsPerMinute: number;
	avgSpeedInMetersPerSecond: number;
	maxSpeedInMetersPerSecond: number;
	totalElevationInMeters: number;
	calories: number;
	sport: string;
	fitnessData?: {
		fullDataUrl?: string;
	};
}

interface ZwiftFitnessData {
	powerInWatts?: number[];
	heartRate?: number[];
	cadencePerMin?: number[];
	distanceInCm?: number[];
	speedInCmPerSec?: number[];
	altitudeInCm?: number[];
	latlng?: Array<[number, number]>;
	timeInSec?: number[];
}

interface ZwiftPowerCurve {
	zFtp?: number;
	zMap?: number;
	vo2Max?: number;
	efforts?: Array<{
		duration: number; // seconds
		watts: number;
		timestamp: string;
	}>;
}

// ============================================================
// Parsed types
// ============================================================

export interface ParsedZwiftActivity {
	externalId: string;
	activityType: string;
	name: string;
	startedAt: Date;
	endedAt: Date;
	raw: Record<string, unknown>;
}

export interface ParsedZwiftStreamSample {
	recordedAt: Date;
	heartRate?: number;
	power?: number;
	cadence?: number;
	speed?: number; // m/s
	altitude?: number; // meters
	distance?: number; // cumulative meters
	lat?: number;
	lng?: number;
}

// ============================================================
// Parsing — pure functions
// ============================================================

export function mapZwiftSport(sport: string): string {
	switch (sport.toUpperCase()) {
		case "CYCLING":
			return "cycling";
		case "RUNNING":
			return "running";
		default:
			return "other";
	}
}

export function parseZwiftActivity(act: ZwiftActivitySummary): ParsedZwiftActivity {
	return {
		externalId: act.id_str || String(act.id),
		activityType: mapZwiftSport(act.sport),
		name: act.name,
		startedAt: new Date(act.startDate),
		endedAt: new Date(act.endDate),
		raw: {
			distanceMeters: act.distanceInMeters,
			avgHeartRate: act.avgHeartRate,
			maxHeartRate: act.maxHeartRate,
			avgWatts: act.avgWatts,
			maxWatts: act.maxWatts,
			avgCadence: act.avgCadenceInRotationsPerMinute,
			avgSpeed: act.avgSpeedInMetersPerSecond,
			maxSpeed: act.maxSpeedInMetersPerSecond,
			elevationGain: act.totalElevationInMeters,
			calories: act.calories,
		},
	};
}

export function parseZwiftFitnessData(
	data: ZwiftFitnessData,
	activityStart: Date,
): ParsedZwiftStreamSample[] {
	const samples: ParsedZwiftStreamSample[] = [];
	const times = data.timeInSec ?? [];
	const length = Math.max(
		times.length,
		data.powerInWatts?.length ?? 0,
		data.heartRate?.length ?? 0,
	);

	for (let i = 0; i < length; i++) {
		const offsetSec = times[i] ?? i;
		const recordedAt = new Date(activityStart.getTime() + offsetSec * 1000);
		const latlng = data.latlng?.[i];

		samples.push({
			recordedAt,
			heartRate: data.heartRate?.[i] ?? undefined,
			power: data.powerInWatts?.[i] ?? undefined,
			cadence: data.cadencePerMin?.[i] ?? undefined,
			speed:
				data.speedInCmPerSec?.[i] != null ? data.speedInCmPerSec[i]! / 100 : undefined,
			altitude: data.altitudeInCm?.[i] != null ? data.altitudeInCm[i]! / 100 : undefined,
			distance:
				data.distanceInCm?.[i] != null ? data.distanceInCm[i]! / 100 : undefined,
			lat: latlng?.[0] ?? undefined,
			lng: latlng?.[1] ?? undefined,
		});
	}

	return samples;
}

// ============================================================
// Zwift API client
// ============================================================

export class ZwiftClient {
	private accessToken: string;
	private athleteId: number;
	private fetchFn: typeof globalThis.fetch;

	constructor(
		accessToken: string,
		athleteId: number,
		fetchFn: typeof globalThis.fetch = globalThis.fetch,
	) {
		this.accessToken = accessToken;
		this.athleteId = athleteId;
		this.fetchFn = fetchFn;
	}

	private async get<T>(path: string): Promise<T> {
		const url = `${ZWIFT_API_BASE}${path}`;
		const response = await this.fetchFn(url, {
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Zwift API error (${response.status}): ${text}`);
		}

		return response.json() as Promise<T>;
	}

	async getProfile(): Promise<ZwiftProfile> {
		return this.get<ZwiftProfile>(`/api/profiles/${this.athleteId}`);
	}

	async getActivities(start = 0, limit = 20): Promise<ZwiftActivitySummary[]> {
		return this.get<ZwiftActivitySummary[]>(
			`/api/profiles/${this.athleteId}/activities?start=${start}&limit=${limit}`,
		);
	}

	async getActivityDetail(activityId: number): Promise<ZwiftActivityDetail> {
		return this.get<ZwiftActivityDetail>(
			`/api/activities/${activityId}?fetchSnapshots=true`,
		);
	}

	async getFitnessData(url: string): Promise<ZwiftFitnessData> {
		const response = await this.fetchFn(url, {
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
				Accept: "application/json",
			},
		});
		if (!response.ok) {
			throw new Error(`Zwift fitness data fetch failed (${response.status})`);
		}
		return response.json() as Promise<ZwiftFitnessData>;
	}

	async getPowerCurve(): Promise<ZwiftPowerCurve> {
		return this.get<ZwiftPowerCurve>("/api/power-curve/power-profile");
	}

	static async signIn(
		username: string,
		password: string,
		fetchFn: typeof globalThis.fetch = globalThis.fetch,
	): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
		const response = await fetchFn(ZWIFT_AUTH_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: "Zwift Game Client",
				grant_type: "password",
				username,
				password,
			}),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Zwift sign-in failed (${response.status}): ${text}`);
		}

		const data = (await response.json()) as ZwiftTokenResponse;
		return {
			accessToken: data.access_token,
			refreshToken: data.refresh_token,
			expiresIn: data.expires_in,
		};
	}

	static async refreshToken(
		refreshToken: string,
		fetchFn: typeof globalThis.fetch = globalThis.fetch,
	): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
		const response = await fetchFn(ZWIFT_AUTH_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: "Zwift Game Client",
				grant_type: "refresh_token",
				refresh_token: refreshToken,
			}),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Zwift token refresh failed (${response.status}): ${text}`);
		}

		const data = (await response.json()) as ZwiftTokenResponse;
		return {
			accessToken: data.access_token,
			refreshToken: data.refresh_token,
			expiresIn: data.expires_in,
		};
	}
}

// ============================================================
// Provider implementation
// ============================================================

export class ZwiftProvider implements Provider {
	readonly id = "zwift";
	readonly name = "Zwift";
	private fetchFn: typeof globalThis.fetch;

	constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
		this.fetchFn = fetchFn;
	}

	validate(): string | null {
		return null;
	}

	authSetup(): ProviderAuthSetup {
		const fetchFn = this.fetchFn;
		return {
			oauthConfig: {
				clientId: "Zwift Game Client",
				authorizeUrl: ZWIFT_AUTH_URL,
				tokenUrl: ZWIFT_AUTH_URL,
				redirectUri: "",
				scopes: [],
			},
			automatedLogin: async (email: string, password: string) => {
				const result = await ZwiftClient.signIn(email, password, fetchFn);

				// Decode JWT to get athleteId
				const payload = JSON.parse(
					Buffer.from(result.accessToken.split(".")[1] ?? "", "base64").toString(),
				) as { sub?: string };
				const athleteId = payload.sub ?? "";

				return {
					accessToken: result.accessToken,
					refreshToken: result.refreshToken,
					expiresAt: new Date(Date.now() + result.expiresIn * 1000),
					scopes: `athleteId:${athleteId}`,
				};
			},
			exchangeCode: async () => {
				throw new Error("Zwift uses automated login, not OAuth code exchange");
			},
		};
	}

	private async resolveTokens(
		db: Database,
	): Promise<{ accessToken: string; athleteId: number }> {
		const stored = await loadTokens(db, this.id);
		if (!stored) {
			throw new Error("Zwift not connected — authenticate via the web UI");
		}

		const athleteIdMatch = stored.scopes?.match(/athleteId:(\S+)/);
		const athleteId = athleteIdMatch ? Number(athleteIdMatch[1]) : 0;
		if (!athleteId) {
			throw new Error("Zwift athlete ID not found — re-authenticate");
		}

		// Refresh if expired
		if (stored.expiresAt <= new Date()) {
			if (!stored.refreshToken) {
				throw new Error("Zwift token expired and no refresh token — re-authenticate");
			}
			console.log("[zwift] Token expired, refreshing...");
			const refreshed = await ZwiftClient.refreshToken(stored.refreshToken, this.fetchFn);
			const tokens = {
				accessToken: refreshed.accessToken,
				refreshToken: refreshed.refreshToken,
				expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
				scopes: `athleteId:${athleteId}`,
			};
			await saveTokens(db, this.id, tokens);
			return { accessToken: refreshed.accessToken, athleteId };
		}

		return { accessToken: stored.accessToken, athleteId };
	}

	async sync(db: Database, since: Date): Promise<SyncResult> {
		const start = Date.now();
		const errors: SyncError[] = [];
		let recordsSynced = 0;

		await ensureProvider(db, this.id, this.name, ZWIFT_API_BASE);

		let client: ZwiftClient;
		try {
			const { accessToken, athleteId } = await this.resolveTokens(db);
			client = new ZwiftClient(accessToken, athleteId, this.fetchFn);
		} catch (err) {
			errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
			return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
		}

		// 1. Sync activities (paginated)
		try {
			const activityCount = await withSyncLog(db, this.id, "activity", async () => {
				let count = 0;
				let offset = 0;
				const PAGE_SIZE = 20;
				let done = false;

				while (!done) {
					const activities = await client.getActivities(offset, PAGE_SIZE);
					if (activities.length === 0) break;

					for (const raw of activities) {
						const actStart = new Date(raw.startDate);
						if (actStart < since) {
							done = true;
							break;
						}

						const parsed = parseZwiftActivity(raw);
						try {
							await db
								.insert(activity)
								.values({
									providerId: this.id,
									externalId: parsed.externalId,
									activityType: parsed.activityType,
									name: parsed.name,
									startedAt: parsed.startedAt,
									endedAt: parsed.endedAt,
									raw: parsed.raw,
								})
								.onConflictDoUpdate({
									target: [activity.providerId, activity.externalId],
									set: {
										activityType: parsed.activityType,
										name: parsed.name,
										startedAt: parsed.startedAt,
										endedAt: parsed.endedAt,
										raw: parsed.raw,
									},
								});
							count++;

							// Fetch detailed streams
							try {
								const detail = await client.getActivityDetail(raw.id);
								if (detail.fitnessData?.fullDataUrl) {
									const fitnessData = await client.getFitnessData(
										detail.fitnessData.fullDataUrl,
									);
									const samples = parseZwiftFitnessData(fitnessData, parsed.startedAt);
									const BATCH_SIZE = 500;
									for (let i = 0; i < samples.length; i += BATCH_SIZE) {
										const batch = samples.slice(i, i + BATCH_SIZE);
										await db
											.insert(metricStream)
											.values(
												batch.map((s) => ({
													providerId: this.id,
													recordedAt: s.recordedAt,
													heartRate: s.heartRate,
													power: s.power,
													cadence: s.cadence,
													speed: s.speed,
													altitude: s.altitude,
													distance: s.distance,
													lat: s.lat,
													lng: s.lng,
												})),
											)
											.onConflictDoNothing();
									}
								}
							} catch (streamErr) {
								// Non-fatal: log but continue
								errors.push({
									message: `streams ${parsed.externalId}: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`,
									externalId: parsed.externalId,
									cause: streamErr,
								});
							}
						} catch (err) {
							errors.push({
								message: err instanceof Error ? err.message : String(err),
								externalId: parsed.externalId,
								cause: err,
							});
						}
					}

					offset += PAGE_SIZE;
				}

				return { recordCount: count, result: count };
			});
			recordsSynced += activityCount;
		} catch (err) {
			errors.push({
				message: `activity: ${err instanceof Error ? err.message : String(err)}`,
				cause: err,
			});
		}

		// 2. Sync power curve as daily metrics (FTP, VO2max)
		try {
			const powerCount = await withSyncLog(db, this.id, "power_curve", async () => {
				const curve = await client.getPowerCurve();
				if (!curve.zFtp && !curve.vo2Max) return { recordCount: 0, result: 0 };

				const today = new Date().toISOString().slice(0, 10);
				await db
					.insert(dailyMetrics)
					.values({
						date: today,
						providerId: this.id,
						vo2max: curve.vo2Max,
					})
					.onConflictDoUpdate({
						target: [dailyMetrics.date, dailyMetrics.providerId],
						set: { vo2max: curve.vo2Max },
					});

				return { recordCount: 1, result: 1 };
			});
			recordsSynced += powerCount;
		} catch (err) {
			errors.push({
				message: `power_curve: ${err instanceof Error ? err.message : String(err)}`,
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
