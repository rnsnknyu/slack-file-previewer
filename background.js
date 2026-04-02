// Service Worker: fetches cross-origin URLs with Slack cookies
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "sfp-download") return false;

  (async () => {
    try {
      console.log("[SFP-BG] Fetching:", msg.url);

      // Get Slack cookies for authentication
      const cookies = await chrome.cookies.getAll({ domain: ".slack.com" });
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join("; ");
      console.log("[SFP-BG] Cookies:", cookies.length);

      const resp = await fetch(msg.url, {
        headers: { "Cookie": cookieStr },
        redirect: "follow",
      });

      console.log("[SFP-BG] Status:", resp.status, resp.url);

      if (!resp.ok) {
        sendResponse({ ok: false, error: `HTTP ${resp.status}` });
        return;
      }

      const text = await resp.text();
      console.log("[SFP-BG] Got content, length:", text.length);
      sendResponse({ ok: true, text });
    } catch (e) {
      console.error("[SFP-BG] Error:", e);
      sendResponse({ ok: false, error: e.message });
    }
  })();

  return true;
});
