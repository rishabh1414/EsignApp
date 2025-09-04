// src/utils/eventBus.js
import fetch from "node-fetch";

const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

export async function emitEvent(event, payload = {}) {
  if (!WEBHOOK_URL) return; // silently ignore if not configured
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event, // e.g., "document.viewed" | "document.signed"
        at: new Date().toISOString(),
        ...payload, // include all extra data
      }),
    });
  } catch (err) {
    // don't crash the flow on webhook errors
    console.error("Webhook POST failed:", err.message);
  }
}
