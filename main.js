(() => {
  "use strict";

  const LOG = "[SFP]";
  const log = (...a) => console.log(LOG, ...a);
  const warn = (...a) => console.warn(LOG, ...a);

  const EYE_ICON = `<svg viewBox="0 0 16 16" style="width:14px;height:14px;fill:currentColor;vertical-align:middle"><path d="M8 3C4.5 3 1.6 5.1.3 8c1.3 2.9 4.2 5 7.7 5s6.4-2.1 7.7-5c-1.3-2.9-4.2-5-7.7-5zm0 8.3A3.3 3.3 0 1 1 8 4.7a3.3 3.3 0 0 1 0 6.6zm0-5.3a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>`;

  const processed = new WeakSet();
  const FILE_RE = /\.(md|markdown|html|htm)(\.{3}|…)?$/i;
  const SUBTITLE_HINTS = /^(html|markdown(\s+file)?|md)$/i;

  function normalizeExt(e) { e = e.toLowerCase(); return e === "markdown" ? "md" : e === "htm" ? "html" : e; }
  function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  // ============================================================
  // Token capture
  // ============================================================
  let _token = null;
  let _teamId = null;

  try { const m = location.pathname.match(/\/client\/(T[A-Z0-9]+)/i); if (m) _teamId = m[1]; } catch (e) {}

  // Intercept Slack's own fetch to grab token
  const _origFetch = window.fetch;
  window.fetch = function (...args) {
    try {
      const body = typeof args[1]?.body === "string" ? args[1].body : "";
      const m = body.match(/token=(xoxc-[^&]+)/);
      if (m && !_token) { _token = decodeURIComponent(m[1]); log("Token captured"); }
    } catch (e) {}
    return _origFetch.apply(this, args);
  };
  const _origXHR = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (typeof body === "string") {
        const m = body.match(/token=(xoxc-[^&]+)/);
        if (m && !_token) { _token = decodeURIComponent(m[1]); log("Token from XHR"); }
      }
    } catch (e) {}
    return _origXHR.call(this, body);
  };

  function findToken() {
    if (_token) return _token;
    try { if (window.boot_data?.api_token) return (_token = window.boot_data.api_token); } catch (e) {}
    try { if (window.TS?.boot_data?.api_token) return (_token = window.TS.boot_data.api_token); } catch (e) {}
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const v = localStorage.getItem(localStorage.key(i));
        if (v) { const m = v.match(/(xoxc-[a-zA-Z0-9-]+)/); if (m) return (_token = m[1]); }
      }
    } catch (e) {}
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const v = sessionStorage.getItem(sessionStorage.key(i));
        if (v) { const m = v.match(/(xoxc-[a-zA-Z0-9-]+)/); if (m) return (_token = m[1]); }
      }
    } catch (e) {}
    return null;
  }

  // ============================================================
  // Download via bridge → service worker (bypasses CORS)
  // ============================================================
  let _reqId = 0;
  function downloadViaBridge(url) {
    return new Promise((resolve, reject) => {
      const requestId = `sfp-dl-${++_reqId}`;
      const timeout = setTimeout(() => { cleanup(); reject(new Error("Timeout")); }, 15000);

      function handler(e) {
        if (e.data?.type !== "sfp-download-response" || e.data.requestId !== requestId) return;
        cleanup();
        if (e.data.ok) resolve(e.data.text);
        else reject(new Error(e.data.error || "Download failed"));
      }
      function cleanup() { clearTimeout(timeout); window.removeEventListener("message", handler); }

      window.addEventListener("message", handler);
      window.postMessage({ type: "sfp-download-request", requestId, url }, "*");
    });
  }

  // ============================================================
  // DOM helpers
  // ============================================================
  function findFileCard(el) {
    let node = el;
    for (let i = 0; i < 15 && node; i++) {
      if (node.matches?.('[class*="file"], [class*="File"], [class*="attachment"], [data-qa*="file"]')) return node;
      if (node.tagName === "A" && node.href?.includes("/files/")) return node;
      node = node.parentElement;
    }
    return el.closest("a") || el.parentElement?.parentElement?.parentElement;
  }

  function extractFileInfo(card) {
    if (!card) return {};

    // Collect links: card → parent anchor → message container
    const anchors = [...card.querySelectorAll("a[href]")];
    let node = card;
    // Walk up to find parent anchors and message container
    for (let i = 0; i < 10 && node; i++) {
      if (node.tagName === "A" && node.href) anchors.push(node);
      node = node.parentElement;
    }
    const msg = card.closest('[role="listitem"], [role="article"], [class*="message"], [data-qa*="message"]');
    if (msg) anchors.push(...msg.querySelectorAll("a[href]"));

    for (const a of anchors) {
      const m = a.href?.match(/\/files\/([A-Z0-9]+)\/(F[A-Z0-9]+)/i);
      if (m) return { fileId: m[2], fileUrl: a.href };
    }

    // Scan card HTML for file ID
    const html = card.outerHTML;
    const m = html.match(/\b(F[A-Z0-9]{8,14})\b/);
    if (m) return { fileId: m[1], fileUrl: null };

    // Last resort: scan the parent message HTML
    if (msg) {
      const msgHtml = msg.innerHTML;
      const fileUrls = msgHtml.match(/\/files\/[A-Z0-9]+\/(F[A-Z0-9]+)/gi);
      if (fileUrls) {
        // Return the last match (most likely the current file card's)
        for (const match of fileUrls) {
          const fm = match.match(/(F[A-Z0-9]+)$/i);
          if (fm) return { fileId: fm[1], fileUrl: null };
        }
      }
    }

    return {};
  }

  // ============================================================
  // Fetch file content
  // ============================================================
  async function fetchFileContent(fileId, fileUrl) {
    findToken();
    log("Fetch:", { fileId, fileUrl, hasToken: !!_token, teamId: _teamId });

    // Step 1: Get download URL via Slack API (same-origin, works)
    if (fileId && _token) {
      log("Calling /api/files.info...");
      try {
        let body = `token=${encodeURIComponent(_token)}&file=${encodeURIComponent(fileId)}`;
        if (_teamId) body += `&team_id=${encodeURIComponent(_teamId)}`;

        const r = await _origFetch.call(window, "/api/files.info", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        const data = await r.json();
        log("API:", data.ok ? "OK" : "FAIL", data.error || "", data.file?.name || "");

        if (data.ok && data.file) {
          // Inline content (small files / snippets)
          if (data.file.content) { log("Got inline content"); return data.file.content; }
          if (data.file.plain_text) { log("Got plain_text"); return data.file.plain_text; }

          // Download URL → use bridge to bypass CORS
          const dlUrl = data.file.url_private_download || data.file.url_private;
          if (dlUrl) {
            log("Downloading via bridge:", dlUrl);
            const text = await downloadViaBridge(dlUrl);
            log("Download OK, length:", text.length);
            return text;
          }
        }
      } catch (e) {
        warn("API/download error:", e.message);
      }
    }

    // Step 2: Fallback - try viewer URL via bridge
    if (fileUrl) {
      log("Trying viewer URL via bridge...");
      try {
        const html = await downloadViaBridge(fileUrl);
        if (!html.includes("<!DOCTYPE") || html.length < 2000) return html;
        // Extract url_private from page
        const m = html.match(/"url_private_download"\s*:\s*"(https:[^"]+)"/);
        const m2 = html.match(/"url_private"\s*:\s*"(https:[^"]+)"/);
        const pUrl = (m || m2)?.[1]?.replace(/\\\//g, "/");
        if (pUrl) {
          log("Found private URL, downloading...");
          return await downloadViaBridge(pUrl);
        }
      } catch (e) {
        warn("Viewer fallback error:", e.message);
      }
    }

    throw new Error(_token ? "ファイルのダウンロードに失敗" : "APIトークンが未取得。Slackを少し操作してから再試行してください");
  }

  // ============================================================
  // Preview modal
  // ============================================================
  function showPreview(filename, content, ext) {
    document.querySelector(".sfp-overlay")?.remove();
    const overlay = document.createElement("div");
    overlay.className = "sfp-overlay";
    const nExt = normalizeExt(ext);
    overlay.innerHTML = `
      <div class="sfp-modal">
        <div class="sfp-modal-header">
          <div class="sfp-modal-title">
            <span class="sfp-badge ${nExt === "md" ? "sfp-badge-md" : "sfp-badge-html"}">${nExt === "md" ? "MD" : "HTML"}</span>
            ${escapeHtml(filename)}
          </div>
          <button class="sfp-close-btn" title="Close">&times;</button>
        </div>
        <div class="sfp-modal-body ${nExt === "md" ? "sfp-markdown" : ""}" id="sfp-content"></div>
      </div>`;
    document.body.appendChild(overlay);
    const cel = overlay.querySelector("#sfp-content");
    if (nExt === "md") {
      if (typeof marked !== "undefined" && marked.parse) cel.innerHTML = marked.parse(content);
      else { const p = document.createElement("pre"); p.style.whiteSpace = "pre-wrap"; p.textContent = content; cel.appendChild(p); }
    } else {
      const iframe = document.createElement("iframe");
      iframe.sandbox = "allow-scripts";
      cel.style.padding = "0";
      cel.appendChild(iframe);
      iframe.srcdoc = content;
    }
    const close = () => overlay.remove();
    overlay.querySelector(".sfp-close-btn").onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    document.addEventListener("keydown", function h(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", h); } });
  }

  // Check if a preview button already exists near an element
  function hasNearbyBtn(el) {
    // Check siblings
    if (el.nextElementSibling?.classList?.contains("sfp-preview-btn")) return true;
    if (el.previousElementSibling?.classList?.contains("sfp-preview-btn")) return true;
    // Check parent and ancestors up to 5 levels
    let p = el.parentElement;
    for (let i = 0; i < 5 && p; i++) {
      if (p.querySelector(".sfp-preview-btn")) return true;
      p = p.parentElement;
    }
    return false;
  }

  // ============================================================
  // Button + scan
  // ============================================================
  function createBtn(filename, ext, card) {
    const btn = document.createElement("button");
    btn.className = "sfp-preview-btn";
    btn.innerHTML = `${EYE_ICON} Preview`;
    btn.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      btn.textContent = "Loading…"; btn.disabled = true;
      try {
        let { fileId, fileUrl } = extractFileInfo(card);
        log("Click:", { fileId, fileUrl });
        // If card failed, try searching from the button itself upward
        if (!fileId && !fileUrl) {
          let p = btn.parentElement;
          for (let i = 0; i < 20 && p; i++) {
            const links = p.querySelectorAll("a[href]");
            for (const a of links) {
              const m = a.href?.match(/\/files\/([A-Z0-9]+)\/(F[A-Z0-9]+)/i);
              if (m) { fileId = m[2]; fileUrl = a.href; break; }
            }
            if (fileId) break;
            p = p.parentElement;
          }
        }
        if (!fileId && !fileUrl) throw new Error("ファイルIDが見つかりません");
        const content = await fetchFileContent(fileId, fileUrl);
        showPreview(filename, content, ext);
      } catch (err) { warn(err); alert("Preview failed: " + err.message); }
      finally { btn.innerHTML = `${EYE_ICON} Preview`; btn.disabled = false; }
    });
    return btn;
  }

  function scan() {
    let n = 0;
    document.querySelectorAll('[data-qa="message_file_title"], [data-qa="file_title"], [data-qa="file_name"], [data-qa="attachment_title"], .c-file__title, .c-file_container__title, .p-file_list__file_name, .c-message_attachment__title').forEach(el => { n += tryAdd(el); });
    document.querySelectorAll("span, div").forEach(el => {
      if (processed.has(el)) return;
      const t = el.textContent?.trim();
      if (!t || !SUBTITLE_HINTS.test(t) || el.children.length > 0) return;
      const card = findFileCard(el);
      if (!card || processed.has(card)) return;
      if (hasNearbyBtn(el)) { processed.add(card); return; }
      const titleEl = findTitle(el, t); if (!titleEl || processed.has(titleEl)) return;
      if (hasNearbyBtn(titleEl)) { processed.add(titleEl); processed.add(card); return; }
      processed.add(titleEl); processed.add(card); processed.add(el);
      const ext = /html/i.test(t) ? "html" : "md";
      titleEl.parentElement.insertBefore(createBtn(titleEl.textContent?.trim() || "file." + ext, ext, card), titleEl.nextSibling);
      n++;
    });
    document.querySelectorAll("span, div, a").forEach(el => {
      if (processed.has(el)) return;
      const t = el.textContent?.trim();
      if (!t || t.length > 200 || !FILE_RE.test(t) || el.children.length > 2) return;
      const ctx = el.closest('[class*="file"], [class*="File"], [class*="attachment"], [data-qa*="file"]');
      if (!ctx) return;
      if (ctx.querySelector(".sfp-preview-btn")) { processed.add(el); return; }
      processed.add(el); const m = t.match(FILE_RE);
      el.parentElement.insertBefore(createBtn(t, m[1], findFileCard(el)), el.nextSibling); n++;
    });
    if (n > 0) log(`Added ${n} button(s)`);
  }
  function tryAdd(el) {
    if (processed.has(el)) return 0;
    const t = el.textContent?.trim(); if (!t) return 0;
    const card = findFileCard(el);
    if (hasNearbyBtn(el)) { processed.add(el); if (card) processed.add(card); return 0; }
    const m = t.match(FILE_RE);
    if (m) { processed.add(el); el.parentElement.insertBefore(createBtn(t, m[1], card), el.nextSibling); return 1; }
    const ext = detectSub(card);
    if (ext) { processed.add(el); el.parentElement.insertBefore(createBtn(t, ext, card), el.nextSibling); return 1; }
    return 0;
  }
  function detectSub(card) {
    if (!card) return null;
    for (const s of card.querySelectorAll("span, div")) { const t = s.textContent?.trim(); if (t && s.children.length === 0 && SUBTITLE_HINTS.test(t)) return /html/i.test(t) ? "html" : "md"; }
    return null;
  }
  function findTitle(subEl, subText) {
    let p = subEl.parentElement;
    for (let d = 0; d < 5 && p; d++) {
      for (const c of p.children) { if (c === subEl || c.contains(subEl)) continue; const t = c.textContent?.trim(); if (t && t !== subText && !SUBTITLE_HINTS.test(t) && t.length < 200) return c; }
      p = p.parentElement;
    }
    return null;
  }

  // Boot
  let timer = null;
  new MutationObserver(() => { if (timer) clearTimeout(timer); timer = setTimeout(scan, 300); }).observe(document.body, { childList: true, subtree: true });
  log("v2.0 loaded (MAIN world)");
  findToken();
  log("Token:", _token ? "YES" : "waiting for capture...");
  log("Team:", _teamId || "?");
  setTimeout(scan, 800);
  setInterval(scan, 3000);
})();
