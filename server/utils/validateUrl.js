export function validateDownloadUrl(
  urlStr,
  allowedHosts = [
    "youtube.com",
    "youtu.be",
    "facebook.com",
    "fb.watch",
    "m.facebook.com",
    "instagram.com",
    "www.instagram.com",
    "instagr.am",
    "threads.net",
    "www.threads.net",
    "threads.com",
    "www.threads.com"
  ]
) {
  try {
    const u = new URL(urlStr);
    if (!["http:", "https:"].includes(u.protocol)) return false;

    const host = u.hostname.toLowerCase();

    return allowedHosts.some(
      (h) => host === h || host.endsWith("." + h)
    );
  } catch {
    return false;
  }
}