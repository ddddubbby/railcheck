// EXCK pool file: a 16-byte header, then columns. v1: amounts (f64), times
// (u32). v2 adds a group per deposit (u32). v3 always has the group column
// (0xFFFFFFFF = no group) and adds a kind per deposit (u8: 0 public shield,
// 1 reshield), padded to 4 bytes.
export const NO_GROUP = 0xffffffff;
const KINDS = ["public", "reshield"];
export const poolSize = (version, n) =>
  16 + n * (version === 1 ? 12 : 16) + (version === 3 ? n + ((4 - (n % 4)) % 4) : 0);
export function decode(buffer, manifest) {
  const v = new DataView(buffer);
  if (
    buffer.byteLength < 16 ||
    String.fromCharCode(...new Uint8Array(buffer, 0, 4)) !== "EXCK"
  )
    throw Error("Invalid pool file.");
  const version = v.getUint32(4, true),
    n = v.getUint32(8, true);
  if (
    ![1, 2, 3].includes(version) ||
    manifest.version !== version ||
    n !== manifest.count ||
    buffer.byteLength !== poolSize(version, n) ||
    v.getUint32(12, true) !== 0
  )
    throw Error("Invalid pool format.");
  const deposits = [];
  let previous = 0;
  for (let i = 0; i < n; i++) {
    const amount = v.getFloat64(16 + i * 8, true),
      time = v.getUint32(16 + n * 8 + i * 4, true);
    if (!Number.isSafeInteger(amount) || amount < 0 || time < previous)
      throw Error("Invalid deposit.");
    const deposit = { id: i, amount, time };
    // Version 2 adds the depositor group: deposits from one address share it.
    if (version >= 2) {
      const group = v.getUint32(16 + n * 12 + i * 4, true);
      if (group !== NO_GROUP) deposit.group = group;
    }
    if (version === 3) {
      const kind = KINDS[v.getUint8(16 + n * 16 + i)];
      if (!kind) throw Error("Invalid deposit kind.");
      deposit.kind = kind;
    }
    deposits.push(deposit);
    previous = time;
  }
  return deposits;
}
