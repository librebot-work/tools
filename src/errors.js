// Aggregated source-validation errors. Every failure carries the file,
// field, and cause so CLI, server, and UI surfaces can render it identically.

export class BotSourceError extends Error {
  /** @type {Array<{ file: string; field: string; message: string }>} */
  errors;
  /** @type {Array<{ file: string; field: string; message: string }>} */
  warnings;

  /**
   * @param {Array<{ file: string; field: string; message: string }>} errors
   * @param {Array<{ file: string; field: string; message: string }>} [warnings]
   */
  constructor(errors, warnings = []) {
    super(
      "invalid bot source: " +
        errors.map((e) => `${e.file}:${e.field}: ${e.message}`).join("; "),
    );
    this.name = "BotSourceError";
    this.errors = errors;
    this.warnings = warnings;
  }
}

/** @param {unknown} value */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
