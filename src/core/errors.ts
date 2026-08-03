/** Base for all errors this tool raises deliberately. */
export class OeqError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Spreadsheet could not be read or is structurally invalid. */
export class SheetError extends OeqError {}

/** A column header is not a valid xpath, or a row is unusable. */
export class ValidationError extends OeqError {}

/** The openEQUELLA API returned an error. */
export class ApiError extends OeqError {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
  }
  /**
   * 4xx are caller mistakes and must never be retried, except 408 and 429,
   * which are transient. 5xx are retryable except 501/505, which mean the
   * server can never service this request no matter how many times it's sent.
   */
  get retryable(): boolean {
    if (this.status === 501 || this.status === 505) return false;
    return (
      this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500
    );
  }
}
