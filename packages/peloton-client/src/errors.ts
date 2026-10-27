export class PelotonServiceError extends Error {
  readonly statusCode: number;
  readonly responseBody: string;

  constructor(statusCode: number, responseBody: string, options?: ErrorOptions) {
    super(`Peloton API error (${statusCode}): ${responseBody}`, options);
    this.name = "PelotonServiceError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export class PelotonAuthenticationError extends PelotonServiceError {
  constructor(statusCode: number, responseBody: string, options?: ErrorOptions) {
    super(statusCode, responseBody, options);
    this.name = "PelotonAuthenticationError";
  }
}

export class PelotonAuthFlowError extends Error {
  readonly stage: string;
  readonly statusCode?: number;
  readonly responseBody?: string;

  constructor(
    stage: string,
    message: string,
    details?: { statusCode?: number; responseBody?: string; cause?: unknown },
  ) {
    super(message, { cause: details?.cause });
    this.name = "PelotonAuthFlowError";
    this.stage = stage;
    this.statusCode = details?.statusCode;
    this.responseBody = details?.responseBody;
  }
}

export class PelotonResponseError extends Error {
  readonly source: string;

  constructor(source: string, cause: unknown) {
    super(`Peloton returned an invalid ${source} response`, { cause });
    this.name = "PelotonResponseError";
    this.source = source;
  }
}
