const url = process.env.VERCEL_DEPLOY_HOOK;
if (!url) {
  console.log("No deploy hook configured.");
  process.exit(0);
}
const parsed = new URL(url);
if (parsed.protocol !== "https:" || parsed.hostname !== "api.vercel.com")
  throw Error("Expected a Vercel HTTPS deploy hook.");
try {
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error();
  console.log("Vercel deployment requested.");
} catch {
  throw Error(
    "Vercel deploy hook failed. The URL is not shown because it is a secret.",
  );
}
