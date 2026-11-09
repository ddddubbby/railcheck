// Draft result format, shared by every advisor and client.
// v2 adds amountExposure, addressLinks and coverage to each assessment. The v1
// fields (score, band, status, findings) stay, so v1 readers keep working.
export const FORMAT = "railcheck.advice/2";
export const STATUS = ["clear", "incomplete", "attention", "not-checked"];
/** Converts bigint amounts to decimal strings, so the result is valid JSON. */
export const toJSON = (result) =>
  JSON.parse(
    JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
