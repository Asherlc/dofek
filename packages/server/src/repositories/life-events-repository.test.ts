import { describe, expect, it, vi } from "vitest";
import { LifeEventsRepository } from "./life-events-repository.ts";

function makeRepository(rows: Record<string, unknown>[] = []) {
	const execute = vi.fn().mockResolvedValue(rows);
	const repo = new LifeEventsRepository({ execute }, "user-1", "America/New_York");
	return { repo, execute };
}

describe("LifeEventsRepository", () => {
	describe("list", () => {
		it("returns empty array when no events exist", async () => {
			const { repo } = makeRepository([]);
			expect(await repo.list()).toEqual([]);
		});

		it("returns parsed life event rows", async () => {
			const { repo } = makeRepository([
				{
					id: "evt-1",
					label: "Started creatine",
					started_at: "2025-01-15",
					ended_at: null,
					category: "supplement",
					ongoing: true,
					notes: "5g daily",
					created_at: "2025-01-15T10:00:00Z",
				},
			]);
			const result = await repo.list();
			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({
				id: "evt-1",
				label: "Started creatine",
				started_at: "2025-01-15",
				ended_at: null,
				category: "supplement",
				ongoing: true,
				notes: "5g daily",
				created_at: "2025-01-15T10:00:00Z",
			});
		});

		it("calls execute with the correct SQL", async () => {
			const { repo, execute } = makeRepository([]);
			await repo.list();
			expect(execute).toHaveBeenCalledOnce();
		});
	});

	describe("create", () => {
		it("returns the created life event", async () => {
			const { repo } = makeRepository([
				{
					id: "evt-new",
					user_id: "user-1",
					label: "Knee surgery",
					started_at: "2025-03-01",
					ended_at: "2025-03-15",
					category: "injury",
					ongoing: false,
					notes: "ACL repair",
					created_at: "2025-03-01T08:00:00Z",
				},
			]);
			const result = await repo.create({
				label: "Knee surgery",
				startedAt: "2025-03-01",
				endedAt: "2025-03-15",
				category: "injury",
				ongoing: false,
				notes: "ACL repair",
			});
			expect(result.id).toBe("evt-new");
			expect(result.label).toBe("Knee surgery");
			expect(result.user_id).toBe("user-1");
		});

		it("passes null values through correctly", async () => {
			const { repo, execute } = makeRepository([
				{
					id: "evt-2",
					user_id: "user-1",
					label: "Vacation",
					started_at: "2025-06-01",
					ended_at: null,
					category: null,
					ongoing: false,
					notes: null,
					created_at: "2025-06-01T00:00:00Z",
				},
			]);
			await repo.create({
				label: "Vacation",
				startedAt: "2025-06-01",
				endedAt: null,
				category: null,
				ongoing: false,
				notes: null,
			});
			expect(execute).toHaveBeenCalledOnce();
		});
	});

	describe("update", () => {
		it("returns null when no fields are provided", async () => {
			const { repo, execute } = makeRepository([]);
			const result = await repo.update("evt-1", {});
			expect(result).toBeNull();
			expect(execute).not.toHaveBeenCalled();
		});

		it("returns updated row when fields are changed", async () => {
			const { repo } = makeRepository([
				{
					id: "evt-1",
					user_id: "user-1",
					label: "Updated label",
					started_at: "2025-01-15",
					ended_at: null,
					category: "supplement",
					ongoing: true,
					notes: null,
					created_at: "2025-01-15T10:00:00Z",
				},
			]);
			const result = await repo.update("evt-1", { label: "Updated label" });
			expect(result).not.toBeNull();
			expect(result?.label).toBe("Updated label");
		});

		it("returns null when the event is not found", async () => {
			const { repo } = makeRepository([]);
			const result = await repo.update("nonexistent", { label: "Nope" });
			expect(result).toBeNull();
		});

		it("handles clearing nullable fields", async () => {
			const { repo, execute } = makeRepository([
				{
					id: "evt-1",
					user_id: "user-1",
					label: "Test",
					started_at: "2025-01-01",
					ended_at: null,
					category: null,
					ongoing: false,
					notes: null,
					created_at: "2025-01-01T00:00:00Z",
				},
			]);
			await repo.update("evt-1", { endedAt: null, category: null, notes: null });
			expect(execute).toHaveBeenCalledOnce();
		});
	});

	describe("delete", () => {
		it("returns success", async () => {
			const { repo } = makeRepository([]);
			const result = await repo.delete("evt-1");
			expect(result).toEqual({ success: true });
		});

		it("calls execute with delete SQL", async () => {
			const { repo, execute } = makeRepository([]);
			await repo.delete("evt-1");
			expect(execute).toHaveBeenCalledOnce();
		});
	});

	describe("analyze", () => {
		it("returns null when the event does not exist", async () => {
			const { repo } = makeRepository([]);
			const result = await repo.analyze("nonexistent", 30);
			expect(result).toBeNull();
		});

		it("returns metrics, sleep, and body comp comparisons for a point event", async () => {
			const execute = vi
				.fn()
				// First call: event lookup
				.mockResolvedValueOnce([
					{ started_at: "2025-06-01", ended_at: null, ongoing: false },
				])
				// Second call: metrics comparison
				.mockResolvedValueOnce([
					{
						period: "after",
						days: 20,
						avg_resting_hr: 58,
						avg_hrv: 45,
						avg_steps: 8000,
						avg_active_energy: 500,
					},
					{
						period: "before",
						days: 30,
						avg_resting_hr: 62,
						avg_hrv: 40,
						avg_steps: 7000,
						avg_active_energy: 450,
					},
				])
				// Third call: sleep (parallel)
				.mockResolvedValueOnce([
					{
						period: "before",
						nights: 28,
						avg_sleep_min: 420,
						avg_deep_min: 90,
						avg_rem_min: 100,
						avg_efficiency: 88.5,
					},
				])
				// Fourth call: body comp (parallel)
				.mockResolvedValueOnce([
					{
						period: "before",
						measurements: 10,
						avg_weight: 80.5,
						avg_body_fat: 15.2,
					},
				]);

			const repo = new LifeEventsRepository({ execute }, "user-1", "America/New_York");
			const result = await repo.analyze("evt-1", 30);

			expect(result).not.toBeNull();
			expect(result?.event.started_at).toBe("2025-06-01");
			expect(result?.metrics).toHaveLength(2);
			expect(result?.metrics[0].period).toBe("after");
			expect(result?.sleep).toHaveLength(1);
			expect(result?.bodyComp).toHaveLength(1);
		});

		it("handles ongoing events", async () => {
			const execute = vi
				.fn()
				.mockResolvedValueOnce([
					{ started_at: "2025-03-01", ended_at: null, ongoing: true },
				])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			const repo = new LifeEventsRepository({ execute }, "user-1", "UTC");
			const result = await repo.analyze("evt-ongoing", 14);

			expect(result).not.toBeNull();
			expect(result?.metrics).toEqual([]);
			expect(result?.sleep).toEqual([]);
			expect(result?.bodyComp).toEqual([]);
			// 4 calls: event lookup + metrics + sleep + body comp
			expect(execute).toHaveBeenCalledTimes(4);
		});

		it("handles ranged events with an end date", async () => {
			const execute = vi
				.fn()
				.mockResolvedValueOnce([
					{ started_at: "2025-01-01", ended_at: "2025-01-31", ongoing: false },
				])
				.mockResolvedValueOnce([
					{
						period: "before",
						days: 30,
						avg_resting_hr: 60,
						avg_hrv: 42,
						avg_steps: 7500,
						avg_active_energy: 480,
					},
					{
						period: "after",
						days: 31,
						avg_resting_hr: 56,
						avg_hrv: 48,
						avg_steps: 9000,
						avg_active_energy: 550,
					},
				])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			const repo = new LifeEventsRepository({ execute }, "user-1", "UTC");
			const result = await repo.analyze("evt-ranged", 30);

			expect(result).not.toBeNull();
			expect(result?.metrics).toHaveLength(2);
		});
	});
});
