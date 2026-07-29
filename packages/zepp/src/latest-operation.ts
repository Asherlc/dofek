export class LatestOperation {
  #sequence = 0;

  begin(): number {
    this.#sequence += 1;
    return this.#sequence;
  }

  isCurrent(operation: number): boolean {
    return operation === this.#sequence;
  }
}
