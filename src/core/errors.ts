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
  /** 4xx are caller mistakes and must never be retried. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}
