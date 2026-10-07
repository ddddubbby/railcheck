export function decode(buffer, manifest) {
  const v = new DataView(buffer);
  if (
    buffer.byteLength < 16 ||
    String.fromCharCode(...new Uint8Array(buffer, 0, 4)) !== "EXCK"
  )
    throw Error("Invalid pool file.");
  const version = v.getUint32(4, true),
    n = v.getUint32(8, true),
    m = v.getUint32(12, true);
  if (
    version !== 2 ||
    manifest.version !== 2 ||
    n !== manifest.count ||
    m !== manifest.withdrawalCount ||
    buffer.byteLength !== 16 + (n + m) * 12
  )
    throw Error("Invalid pool format.");
  const read = (offset, count) => {
    const rows = [];
    let previous = 0;
    for (let i = 0; i < count; i++) {
      const amount = v.getFloat64(16 + (offset + i) * 8, true),
        time = v.getUint32(16 + (n + m) * 8 + (offset + i) * 4, true);
      if (!Number.isSafeInteger(amount) || amount < 0 || time < previous)
        throw Error("Invalid pool entry.");
      rows.push({ id: i, amount, time });
      previous = time;
    }
    return rows;
  };
  return { deposits: read(0, n), withdrawals: read(n, m) };
}
