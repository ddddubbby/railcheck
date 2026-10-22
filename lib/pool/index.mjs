/** No depositor group (reshields, or pools without sender lookup). */
export const NO_GROUP = 0xffffffff;
/** Public shield from an external address. */
export const KIND_SHIELD = 0;
/** Swap-output reshield (Nullified transaction). */
export const KIND_RESHIELD = 1;

const ROW = { 1: 12, 2: 16, 3: 17 };

export function decode(buffer, manifest) {
  const v = new DataView(buffer);
  if (
    buffer.byteLength < 16 ||
    String.fromCharCode(...new Uint8Array(buffer, 0, 4)) !== "EXCK"
  )
    throw Error("Invalid pool file.");
  const version = v.getUint32(4, true),
    n = v.getUint32(8, true),
    row = ROW[version];
  if (
    !row ||
    manifest.version !== version ||
    n !== manifest.count ||
    buffer.byteLength !== 16 + n * row ||
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
    // Version 2+ stores a depositor group; version 3 adds a kind byte.
    if (version >= 2) deposit.group = v.getUint32(16 + n * 12 + i * 4, true);
    if (version >= 3) {
      const kind = v.getUint8(16 + n * 16 + i);
      if (kind !== KIND_SHIELD && kind !== KIND_RESHIELD)
        throw Error("Invalid deposit kind.");
      deposit.kind = kind;
    } else deposit.kind = KIND_SHIELD;
    deposits.push(deposit);
    previous = time;
  }
  return deposits;
}
