export function decode(buffer, manifest) {
  const v = new DataView(buffer);
  if (
    buffer.byteLength < 16 ||
    String.fromCharCode(...new Uint8Array(buffer, 0, 4)) !== "EXCK"
  )
    throw Error("Invalid pool file.");
  const version = v.getUint32(4, true),
    n = v.getUint32(8, true),
    grouped = version === 2;
  if (
    (version !== 1 && version !== 2) ||
    manifest.version !== version ||
    n !== manifest.count ||
    buffer.byteLength !== 16 + n * (grouped ? 16 : 12) ||
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
    // Version 2 adds the depositor group: deposits from one address share it.
    deposits.push(
      grouped
        ? { id: i, amount, time, group: v.getUint32(16 + n * 12 + i * 4, true) }
        : { id: i, amount, time },
    );
    previous = time;
  }
  return deposits;
}
