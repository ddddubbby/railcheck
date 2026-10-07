import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
const roots = new Set([
  "docs",
  "src",
  "public",
  "lib",
  "scripts",
  "tests",
  "data",
  ".github",
  "README.md",
  "LICENSE",
  "package.json",
  "package-lock.json",
  "vercel.json",
  ".gitignore",
  ".env.example",
]);
const table = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let b = 0; b < 8; b++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const paths = [];
function walk(directory = "") {
  for (const name of readdirSync(directory || ".")) {
    if (!directory && !roots.has(name)) continue;
    if (
      ["node_modules", ".git", ".DS_Store", ".vercel", "dist"].includes(name) ||
      (name.startsWith(".env") && name !== ".env.example") ||
      name.endsWith(".tmp") ||
      (directory === "data" && name === "validation.json")
    )
      continue;
    const path = directory ? `${directory}/${name}` : name;
    if (statSync(path).isDirectory()) walk(path);
    else paths.push(path);
  }
}
walk();
const local = [],
  central = [];
let offset = 0;
for (const path of paths) {
  const name = Buffer.from(path),
    data = readFileSync(path),
    compressed = deflateRawSync(data),
    crc = crc32(data),
    l = Buffer.alloc(30);
  l.writeUInt32LE(0x04034b50);
  l.writeUInt16LE(20, 4);
  l.writeUInt16LE(8, 8);
  l.writeUInt32LE(crc, 14);
  l.writeUInt32LE(compressed.length, 18);
  l.writeUInt32LE(data.length, 22);
  l.writeUInt16LE(name.length, 26);
  local.push(l, name, compressed);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50);
  c.writeUInt16LE(20, 4);
  c.writeUInt16LE(20, 6);
  c.writeUInt16LE(8, 10);
  c.writeUInt32LE(crc, 16);
  c.writeUInt32LE(compressed.length, 20);
  c.writeUInt32LE(data.length, 24);
  c.writeUInt16LE(name.length, 28);
  c.writeUInt32LE(offset, 42);
  central.push(c, name);
  offset += l.length + name.length + compressed.length;
}
const directory = Buffer.concat(central),
  end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50);
end.writeUInt16LE(paths.length, 8);
end.writeUInt16LE(paths.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
writeFileSync("dist/source.zip", Buffer.concat([...local, directory, end]));
