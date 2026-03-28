import { describe, expect, it, vi } from "vitest";
import {
	DurationCurvesRepository,
	fitCriticalHeartRate,
} from "./duration-curves-repository.ts";

// ── fitCriticalHeartRate ─────────────────────────────────────

describe("fitCriticalHeartRate", () => {
	it("returns null for empty data", () => {
		expect(fitCriticalHeartRate([])).toBeNull();
	});

	it("returns null when fewer than 3 valid points (>= 120s)", () => {
		const points = [
			{ durationSeconds: 120, bestHeartRate: 170 },
			{ durationSeconds: 300, bestHeartRate: 165 },
		];
		expect(fitCriticalHeartRate(points)).toBeNull();
	});

	it("returns null when all durations are below 120s", () => {
		const points = [
			{ durationSeconds: 5, bestHeartRate: 190 },
			{ durationSeconds: 15, bestHeartRate: 185 },
			{ durationSeconds: 30, bestHeartRate: 180 },
			{ durationSeconds: 60, bestHeartRate: 175 },
		];
		expect(fitCriticalHeartRate(points)).toBeNull();
	});

	it("returns null when bestHeartRate is zero", () => {
		const points = [
			{ durationSeconds: 120, bestHeartRate: 0 },
			{ durationSeconds: 300, bestHeartRate: 0 },
			{ durationSeconds: 600, bestHeartRate: 0 },
		];
		expect(fitCriticalHeartRate(points)).toBeNull();
	});

	it("fits a model from realistic HR curve data", () => {
		const points = [
			{ durationSeconds: 120, bestHeartRate: 180 },
			{ durationSeconds: 300, bestHeartRate: 172 },
			{ durationSeconds: 600, bestHeartRate: 168 },
			{ durationSeconds: 1200, bestHeartRate: 164 },
			{ durationSeconds: 1800, bestHeartRate: 162 },
			{ durationSeconds: 3600, bestHeartRate: 158 },
		];
		const model = fitCriticalHeartRate(points);
		expect(model).not.toBeNull();
		expect(model?.thresholdHr).toBeGreaterThan(140);
		expect(model?.thresholdHr).toBeLessThan(180);
		expect(model?.r2).toBeGreaterThan(0.9);
		expect(model?.r2).toBeLessThanOrEqual(1);
	});

	it("returns integer thresholdHr and 3-decimal r2", () => {
		const points = [
			{ durationSeconds: 120, bestHeartRate: 175 },
			{ durationSeconds: 300, bestHeartRate: 170 },
			{ durationSeconds: 600, bestHeartRate: 165 },
			{ durationSeconds: 1800, bestHeartRate: 160 },
		];
		const model = fitCriticalHeartRate(points);
		expect(model).not.toBeNull();
		expect(Number.isInteger(model?.thresholdHr)).toBe(true);
		// r2 should have at most 3 decimal places
		const r2Str = String(model?.r2);
		const decimalPart = r2Str.split(".")[1] ?? "";
		expect(decimalPart.length).toBeLessThanOrEqual(3);
	});
});

// ── DurationCurvesRepository ─────────────────────────────────

describe("DurationCurvesRepository", () => {
	function makeRepository(rows: Record<string, unknown>[] = []) {
		const execute = vi.fn().mockResolvedValue(rows);
		const repo = new DurationCurvesRepository({ execute }, "user-1", "UTC");
		return { repo, execute };
	}

	describe("getHrCurve", () => {
		it("returns empty points and null model when no data", async () => {
			const { repo } = makeRepository([]);
			const result = await repo.getHrCurve(90);
			expect(result.points).toEqual([]);
			expect(result.model).toBeNull();
		});

		it("maps rows to HrCurvePoint objects with labels", async () => {
			const { repo } = makeRepository([
				{ duration_seconds: "300", best_hr: "170", activity_date: "2025-06-15" },
				{ duration_seconds: "600", best_hr: "165", activity_date: "2025-06-14" },
			]);
			const result = await repo.getHrCurve(90);
			expect(result.points).toHaveLength(2);
			expect(result.points[0]).toEqual({
				durationSeconds: 300,
				label: "5min",
				bestHeartRate: 170,
				activityDate: "2025-06-15",
			});
			expect(result.points[1]).toEqual({
				durationSeconds: 600,
				label: "10min",
				bestHeartRate: 165,
				activityDate: "2025-06-14",
			});
		});

		it("calls execute once", async () => {
			const { repo, execute } = makeRepository([]);
			await repo.getHrCurve(30);
			expect(execute).toHaveBeenCalledTimes(1);
		});
	});

	describe("getPaceCurve", () => {
		it("returns empty points when no data", async () => {
			const { repo } = makeRepository([]);
			const result = await repo.getPaceCurve(90);
			expect(result.points).toEqual([]);
		});

		it("maps rows to PaceCurvePoint objects with labels", async () => {
			const { repo } = makeRepository([
				{ duration_seconds: "1800", best_pace: "240.5", activity_date: "2025-06-15" },
				{ duration_seconds: "3600", best_pace: "250.0", activity_date: "2025-06-14" },
			]);
			const result = await repo.getPaceCurve(90);
			expect(result.points).toHaveLength(2);
			expect(result.points[0]).toEqual({
				durationSeconds: 1800,
				label: "30min",
				bestPaceSecondsPerKm: 240.5,
				activityDate: "2025-06-15",
			});
			expect(result.points[1]).toEqual({
				durationSeconds: 3600,
				label: "60min",
				bestPaceSecondsPerKm: 250,
				activityDate: "2025-06-14",
			});
		});

		it("calls execute once", async () => {
			const { repo, execute } = makeRepository([]);
			await repo.getPaceCurve(30);
			expect(execute).toHaveBeenCalledTimes(1);
		});
	});
});
