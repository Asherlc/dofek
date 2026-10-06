export type PageLoadKind = "navigation" | "filter";
export type PageLoadStatus = "ready" | "empty" | "error";
export interface PageLoadEvent {
  route: string;
  section?: string;
  generation: number;
  kind: PageLoadKind;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  outcome: PageLoadStatus | "cancelled";
}
interface PageLoadStart {
  route: string;
  kind: PageLoadKind;
  startedAt: number;
  sections: readonly string[];
}
export class PageLoadTracker {
  #generation = 0;
  #active?: PageLoadStart & { generation: number; results: Map<string, PageLoadStatus> };

  #emit: (event: PageLoadEvent) => void;

  constructor(emit: (event: PageLoadEvent) => void) {
    this.#emit = emit;
  }

  begin(input: PageLoadStart): number {
    if (this.#active) this.cancel(this.#active.generation, input.startedAt);
    const generation = ++this.#generation;
    this.#active = {
      ...input,
      sections: [...new Set(input.sections)],
      generation,
      results: new Map(),
    };
    return generation;
  }

  report(input: {
    generation: number;
    section: string;
    status: PageLoadStatus;
    completedAt: number;
  }): void {
    const active = this.#active;
    if (
      !active ||
      active.generation !== input.generation ||
      !active.sections.includes(input.section) ||
      active.results.has(input.section)
    )
      return;
    active.results.set(input.section, input.status);
    this.#emitEvent(active, input.status, input.completedAt, input.section);
    if (input.status === "error") {
      this.#active = undefined;
      this.#emitEvent(active, "error", input.completedAt);
    } else if (active.results.size === active.sections.length) {
      this.#active = undefined;
      this.#emitEvent(
        active,
        [...active.results.values()].every((status) => status === "empty") ? "empty" : "ready",
        input.completedAt,
      );
    }
  }

  cancel(generation: number, completedAt: number): void {
    const active = this.#active;
    if (!active || active.generation !== generation) return;
    this.#active = undefined;
    this.#emitEvent(active, "cancelled", completedAt);
  }

  #emitEvent(
    active: PageLoadStart & { generation: number },
    outcome: PageLoadEvent["outcome"],
    completedAt: number,
    section?: string,
  ): void {
    this.#emit({
      route: active.route,
      kind: active.kind,
      startedAt: active.startedAt,
      completedAt,
      durationMs: completedAt - active.startedAt,
      generation: active.generation,
      outcome,
      ...(section === undefined ? {} : { section }),
    });
  }
}
