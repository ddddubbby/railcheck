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
    version !== 1 ||
    manifest.version !== 1 ||
    n !== manifest.count ||
    buffer.byteLength !== 16 + n * 12 ||
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
    deposits.push({ id: i, amount, time });
    previous = time;
  }
  return deposits;
}
