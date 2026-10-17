// Draft result format, shared by every advisor and client.
export const FORMAT = "railcheck.advice/1";
export const STATUS = ["clear", "incomplete", "attention", "not-checked"];
/** Converts bigint amounts to decimal strings, so the result is valid JSON. */
export const toJSON = (result) =>
  JSON.parse(
    JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
