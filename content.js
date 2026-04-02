(() => {
  "use strict";

  const EYE_ICON = `<svg viewBox="0 0 16 16"><path d="M8 3C4.5 3 1.6 5.1.3 8c1.3 2.9 4.2 5 7.7 5s6.4-2.1 7.7-5c-1.3-2.9-4.2-5-7.7-5zm0 8.3A3.3 3.3 0 1 1 8 4.7a3.3 3.3 0 0 1 0 6.6zm0-5.3a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>`;

  // Track already-processed elements to avoid duplicates
  const processed = new WeakSet();

  function getFileExtension(filename) {
    const m = filename.match(/\.(md|markdown|html|htm)$/i);
    return m ? m[1].toLowerCase() : null;
  }

  function normalizeExt(ext) {
    if (ext === "markdown") return "md";
    if (ext === "htm") return "html";
    return ext;
  }

  // Find the download URL from a Slack file attachment element
  function findDownloadUrl(el) {
    // Look for a direct download link nearby
    const parent = el.closest("[class*='file']") || el.closest("[class*='attachment']") || el.parentElement?.parentElement?.parentElement;
    if (!parent) return null;

    // Try various Slack DOM patterns for file links
    const links = parent.querySelectorAll("a[href]");
    for (const a of links) {
      const href = a.href;
      if (href && (href.includes("/files-pri/") || href.includes("/files-tmb/") || href.includes("files.slack.com"))) {
        return href;
      }
    }

    // Try the element itself or its parent anchor
    const anchor = el.closest("a[href]");
    if (anchor && anchor.href) return anchor.href;

    return null;
  }

  // Fetch file content
  async function fetchFileContent(url) {
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) throw new Error(`Failed to fetch: ${resp.status}`);
    return resp.text();
  }

  // Create preview modal
  function showPreview(filename, content, ext) {
    // Remove existing modal
    document.querySelector(".sfp-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.className = "sfp-overlay";

    const normalizedExt = normalizeExt(ext);
    const badgeClass = normalizedExt === "md" ? "sfp-badge-md" : "sfp-badge-html";
    const badgeLabel = normalizedExt === "md" ? "MD" : "HTML";

    overlay.innerHTML = `
      <div class="sfp-modal">
        <div class="sfp-modal-header">
          <div class="sfp-modal-title">
            <span class="sfp-badge ${badgeClass}">${badgeLabel}</span>
            ${escapeHtml(filename)}
          </div>
          <button class="sfp-close-btn" title="Close">&times;</button>
        </div>
        <div class="sfp-modal-body ${normalizedExt === "md" ? "sfp-markdown" : ""}" id="sfp-content"></div>
      </div>
    `;

    document.body.appendChild(overlay);

    const contentEl = overlay.querySelector("#sfp-content");

    if (normalizedExt === "md") {
      // Render Markdown using marked.js
      if (typeof marked !== "undefined") {
        contentEl.innerHTML = marked.parse(content);
      } else {
        contentEl.textContent = content;
      }
    } else {
      // Render HTML in a sandboxed iframe
      const iframe = document.createElement("iframe");
      iframe.sandbox = "allow-same-origin";
      contentEl.style.padding = "0";
      contentEl.appendChild(iframe);
      iframe.srcdoc = content;
    }

    // Close handlers
    overlay.querySelector(".sfp-close-btn").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.addEventListener("keydown", function handler(e) {
      if (e.key === "Escape") {
        overlay.remove();
        document.removeEventListener("keydown", handler);
      }
    });
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // Add preview button next to a file element
  function addPreviewButton(el, filename, ext) {
    if (processed.has(el)) return;
    processed.add(el);

    const btn = document.createElement("button");
    btn.className = "sfp-preview-btn";
    btn.innerHTML = `${EYE_ICON} Preview`;
    btn.title = `Preview ${filename}`;

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();

      btn.textContent = "Loading…";
      btn.disabled = true;

      try {
        const url = findDownloadUrl(el);
        if (!url) throw new Error("Download URL not found");
        const content = await fetchFileContent(url);
        showPreview(filename, content, ext);
      } catch (err) {
        console.error("[Slack File Previewer]", err);

        // Fallback: try to find and use Slack's file viewer URL
        try {
          const fileLink = el.closest("a[href]") || el.querySelector("a[href]");
          if (fileLink) {
            // Open Slack's built-in viewer and try to extract content
            const viewUrl = fileLink.href;
            const resp = await fetch(viewUrl, { credentials: "include" });
            const html = await resp.text();
            // Try to find raw content in the page
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, "text/html");
            const pre = doc.querySelector("pre");
            if (pre) {
              showPreview(filename, pre.textContent, ext);
            } else {
              alert(`Could not load file preview.\nPlease try clicking the file name to open it in Slack first.`);
            }
          }
        } catch {
          alert(`Could not load file preview.\n${err.message}`);
        }
      } finally {
        btn.innerHTML = `${EYE_ICON} Preview`;
        btn.disabled = false;
      }
    });

    // Insert button after the filename
    el.after(btn);
  }

  // Scan DOM for file attachments
  function scanForFiles() {
    // Pattern 1: Slack file attachment cards - look for file name spans/divs
    const selectors = [
      // Modern Slack file attachment elements
      '[data-qa="message_file_title"]',
      '[data-qa="file_title"]',
      ".c-file__title",
      ".c-file_container__title",
      ".p-file_list__file_name",
      // Generic: any element that shows a filename
      ".c-message_attachment__title",
    ];

    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const text = el.textContent?.trim();
        if (!text) continue;
        const ext = getFileExtension(text);
        if (ext) addPreviewButton(el, text, ext);
      }
    }

    // Pattern 2: Broader search - links containing .md/.html filenames
    for (const a of document.querySelectorAll('a[href]')) {
      const text = a.textContent?.trim();
      if (!text) continue;
      const ext = getFileExtension(text);
      if (!ext) continue;
      // Only target file links, not random text
      if (a.href.includes("slack.com") || a.href.includes("/files")) {
        addPreviewButton(a, text, ext);
      }
    }
  }

  // Run scan on DOM changes (Slack is a SPA)
  const observer = new MutationObserver(() => {
    scanForFiles();
  });

  // Initial scan + start observing
  scanForFiles();
  observer.observe(document.body, { childList: true, subtree: true });

  console.log("[Slack File Previewer] Extension loaded");
})();
