// ======================================================
// utils/logStream.js
// SSE-safe log sender — flush guaranteed
// ======================================================

export function sendLog(app, message) {
  const res = app.locals.logRes;

  if (!res || res.writableEnded) return;

  try {
    let safeMessage = "";

    if (typeof message === "string") {
      safeMessage = message;
    } else if (message === null || message === undefined) {
      safeMessage = "";
    } else {
      safeMessage = JSON.stringify(message);
    }

    // Escape newlines — protects SSE data: format
    safeMessage = safeMessage.replace(/\r?\n/g, "\\n");

    res.write(`data: ${safeMessage}\n\n`);

    // Force flush — works with or without compression middleware
    if (typeof res.flush === "function") res.flush();

  } catch (err) {
    console.warn("⚠️ sendLog failed:", err.message);
  }
}
