export class OriginalFitRetentionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OriginalFitRetentionError";
  }
}
