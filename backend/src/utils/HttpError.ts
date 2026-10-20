export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    /** Extra machine-readable context returned to the client, e.g. `{ retryAt }`. */
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
