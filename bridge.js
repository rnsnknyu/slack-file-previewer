// Bridge: MAIN world ↔ Service Worker
window.addEventListener("message", (e) => {
  if (e.source !== window || e.data?.type !== "sfp-download-request") return;
  const { requestId, url } = e.data;

  try {
    chrome.runtime.sendMessage({ type: "sfp-download", url }, (resp) => {
      const error = chrome.runtime.lastError;
      window.postMessage({
        type: "sfp-download-response",
        requestId,
        ok: !error && resp?.ok,
        text: resp?.text || null,
        error: error?.message || resp?.error || null,
      }, "*");
    });
  } catch (e) {
    // Extension was reloaded - tell user to reload Slack tab
    window.postMessage({
      type: "sfp-download-response",
      requestId,
      ok: false,
      error: "拡張機能が更新されました。Slackタブをリロードしてください。",
    }, "*");
  }
});
