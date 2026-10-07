import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
const root = resolve("dist"),
  types = {
    ".html": "text/html",
    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".bin": "application/octet-stream",
    ".woff2": "font/woff2",
    ".md": "text/markdown",
    ".zip": "application/zip",
  };
const csp =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
createServer(async (req, res) => {
  try {
    let path = resolve(
      root,
      "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname),
    );
    if (!path.startsWith(root + "/") && path !== root) throw Error();
    try {
      if ((await stat(path)).isDirectory()) path += "/index.html";
    } catch {}
    let status = 200,
      data;
    try {
      data = await readFile(path);
    } catch {
      status = 404;
      path = root + "/404.html";
      data = await readFile(path);
    }
    res.writeHead(status, {
      "Content-Type": types[extname(path)] || "text/plain",
      "Content-Security-Policy": csp,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cache-Control":
        status === 200 && /\/data\/railgun-eth-[a-f0-9]{16}\.bin$/.test(path)
          ? "public, max-age=31536000, immutable"
          : "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(400);
    res.end("Bad request");
  }
}).listen(Number(process.env.PORT || 4173), "127.0.0.1", () =>
  console.log("Local: http://127.0.0.1:" + (process.env.PORT || 4173)),
);
