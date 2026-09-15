export class DesignPortError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "DesignPortError";
    this.code = code;
    this.details = details;
  }
}

export function asDesignPortError(error: unknown): DesignPortError {
  if (error instanceof DesignPortError) {
    return error;
  }

  if (error instanceof Error) {
    return new DesignPortError("INTERNAL_ERROR", error.message);
  }

  return new DesignPortError("INTERNAL_ERROR", String(error));
}
