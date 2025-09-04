// ---------- utils ----------
function $(s) {
  return document.querySelector(s);
}
function show(el) {
  el && el.classList.remove("hidden");
}
function hide(el) {
  el && el.classList.add("hidden");
}
function api(p) {
  return "/api/esign" + p;
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
const qs = new URLSearchParams(location.search);

// ---------- elements ----------
const gate = $("#gate"),
  unauth = $("#unauth"),
  app = $("#app"),
  who = $("#who");
const loader = $("#loader");
const loaderMsg = loader.querySelector("span");
const dropzone = $("#dropzone");
const sigInput = $("#sig");
const btnUpload = $("#btn-upload");
const btnSign = $("#btn-sign");
const pdfContainer = $("#pdfContainer");
const themeToggle = $("#themeToggle");
const yr = $("#yr");
if (yr) yr.textContent = new Date().getFullYear();

// ---------- theme ----------
function setTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem("theme", t);
  } catch (_) {}
}
setTheme(
  (function () {
    try {
      return localStorage.getItem("theme") || "light";
    } catch (_) {
      return "light";
    }
  })()
);
if (themeToggle) {
  themeToggle.addEventListener("click", () => {
    setTheme(
      document.documentElement.getAttribute("data-theme") === "light"
        ? "dark"
        : "light"
    );
  });
}

// ---------- state ----------
let pdfDoc = null,
  canvases = [];
let overlay = null,
  overlayImg = null,
  overlayHandle = null;
let overlayPage = 1;
let session = { recordId: null, sessionId: null };
let sigSelected = false;

// ---------- loader helpers ----------
function setLoader(msg) {
  if (loaderMsg) loaderMsg.textContent = msg || "";
}
function startLoading(msg) {
  setLoader(msg || "Processing…");
  show(loader);
  document.body.classList.add("loading");
}
function stopLoading() {
  hide(loader);
  document.body.classList.remove("loading");
}

// ---------- headers ----------
function authHeaders() {
  return {
    "x-esign-email": qs.get("email") || "",
    "x-esign-name": qs.get("name") || "",
    "x-esign-secret": qs.get("secret") || "",
    "x-esign-doctype": qs.get("docType") || "",
  };
}
function jsonHeaders() {
  const a = authHeaders();
  a["Content-Type"] = "application/json";
  return a;
}

// ---------- init ----------
(async function init() {
  if (typeof window.pdfjsLib === "undefined") {
    alert("pdf.js failed to load");
    return;
  }
  try {
    startLoading("Your document is being prepared for e-signing…");

    const email = qs.get("email"),
      name = qs.get("name"),
      secret = qs.get("secret"),
      docType = qs.get("docType");
    const authRes = await fetch(api("/authorize"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, name, secret, docType }),
    });
    const authJson = await authRes.json();
    if (!authRes.ok || !authJson.ok) {
      hide(gate);
      show(unauth);
      return;
    }
    hide(gate);
    show(app);
    if (who) who.textContent = `Signed in as ${name} <${email}>`;

    // Initialize session & fetch template PDF (from Drive -> GridFS)
    const initData = await fetch(api("/session/init"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({}),
    }).then((r) => r.json());
    session = { ...session, ...initData };

    await fetch(api("/session/open"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ recordId: session.recordId }),
    });

    const pdfBytes = await fetch(api("/session/pdf/" + session.recordId), {
      headers: authHeaders(),
    }).then((r) => r.arrayBuffer());

    // Load & render with devicePixelRatio to avoid blur
    pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes) })
      .promise;
    await renderAllPagesCrisp();

    // UI: dropzone interactions
    wireDropzone();

    // Manual fallback button (kept hidden unless needed)
    if (btnUpload) {
      btnUpload.addEventListener("click", () => {
        const f = sigInput.files && sigInput.files[0];
        if (f) handleSignatureFile(f);
      });
    }

    // Sign click
    if (btnSign) btnSign.addEventListener("click", onSign);
  } catch (e) {
    console.error(e);
    alert("Failed to initialize.");
  } finally {
    stopLoading();
  }
})();

// ---------- render: crisp pages (uses devicePixelRatio) ----------
async function renderAllPagesCrisp() {
  pdfContainer.innerHTML = "";
  canvases = [];

  const DPR = Math.max(1, window.devicePixelRatio || 1);

  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p);

    // Fit width to container; then scale by DPR for crispness
    const containerWidthCSS = pdfContainer.clientWidth || 1000;
    const vp = page.getViewport({ scale: 1 });
    const cssScale = clamp(containerWidthCSS / vp.width, 0.5, 3);
    const viewport = page.getViewport({ scale: cssScale });

    const canvas = document.createElement("canvas");
    canvas.className = "page-canvas";

    // Set internal pixel buffer larger, CSS size remains logical
    canvas.width = Math.floor(viewport.width * DPR);
    canvas.height = Math.floor(viewport.height * DPR);
    canvas.style.width = Math.floor(viewport.width) + "px";
    canvas.style.height = Math.floor(viewport.height) + "px";

    const ctx = canvas.getContext("2d");
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); // scale drawing for DPR

    const pageDiv = document.createElement("div");
    pageDiv.className = "page";
    pageDiv.appendChild(canvas);
    pdfContainer.appendChild(pageDiv);

    canvases.push(canvas);

    await page.render({ canvasContext: ctx, viewport }).promise;
  }

  // default overlay on LAST page, bottom-right
  overlayPage = pdfDoc.numPages;
  attachOverlayToPage(overlayPage);
  placeBottomRight();
}

// ---------- overlay helpers ----------
function attachOverlayToPage(page) {
  if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  const canvas = canvases[page - 1];
  if (!canvas) return;

  const pageDiv = canvas.parentElement;
  pageDiv.style.position = "relative";

  overlay = document.createElement("div");
  overlay.className = "sig-wrapper";
  overlay.innerHTML = `<img id="sigOverlay" alt="Signature"/><div id="sigHandle" class="sig-handle"></div>`;

  overlayImg = overlay.querySelector("#sigOverlay");
  overlayHandle = overlay.querySelector("#sigHandle");

  pageDiv.appendChild(overlay);
  enableDragResize(overlay, canvas);

  // Sign button visible only after signature upload succeeds
  if (btnSign) btnSign.hidden = !sigSelected;
}

function placeBottomRight() {
  const canvas = canvases[overlayPage - 1];
  if (!canvas || !overlay) return;

  // Use current CSS width of canvas (logical pixels)
  const cw = parseInt(canvas.style.width, 10) || canvas.width;
  const ch = parseInt(canvas.style.height, 10) || canvas.height;

  const targetW = Math.floor(cw * 0.3);
  overlay.style.width = targetW + "px";
  overlay.style.left = cw - targetW - 20 + "px";
  overlay.style.top = ch - Math.floor(targetW * 0.33) - 20 + "px";
}

// ---------- drag + resize ----------
function enableDragResize(wrapper, canvas) {
  let dragging = false,
    resizing = false,
    sx = 0,
    sy = 0,
    startL = 0,
    startT = 0,
    startW = 0,
    startH = 0;

  wrapper.addEventListener("mousedown", (e) => {
    if (e.target.classList.contains("sig-handle")) return;
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    startL = wrapper.offsetLeft;
    startT = wrapper.offsetTop;
    e.preventDefault();
  });

  const handle = wrapper.querySelector(".sig-handle");
  handle.addEventListener("mousedown", (e) => {
    resizing = true;
    sx = e.clientX;
    sy = e.clientY;
    startW = wrapper.offsetWidth;
    startH = wrapper.offsetHeight;
    e.stopPropagation();
    e.preventDefault();
  });

  function onMove(e) {
    if (dragging) {
      const cssW = parseInt(canvas.style.width, 10) || canvas.width;
      const cssH = parseInt(canvas.style.height, 10) || canvas.height;
      const nx = clamp(
        startL + (e.clientX - sx),
        0,
        cssW - wrapper.offsetWidth
      );
      const ny = clamp(
        startT + (e.clientY - sy),
        0,
        cssH - wrapper.offsetHeight
      );
      wrapper.style.left = nx + "px";
      wrapper.style.top = ny + "px";
    }
    if (resizing) {
      const cssW = parseInt(canvas.style.width, 10) || canvas.width;
      const nw = clamp(startW + (e.clientX - sx), 60, cssW);
      const scale = nw / startW;
      const nh = Math.max(30, Math.round(startH * scale));
      wrapper.style.width = nw + "px";
      wrapper.style.height = nh + "px";
    }
  }
  function onUp() {
    dragging = false;
    resizing = false;
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// ---------- dropzone UX ----------
function wireDropzone() {
  const openPicker = () => sigInput && sigInput.click();

  dropzone.addEventListener("click", openPicker);
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") openPicker();
  });

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () =>
    dropzone.classList.remove("dragover")
  );
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    if (
      !e.dataTransfer ||
      !e.dataTransfer.files ||
      !e.dataTransfer.files.length
    )
      return;
    sigInput.files = e.dataTransfer.files; // set for consistency
    handleSignatureFile(e.dataTransfer.files[0]);
  });

  // file picker
  sigInput.addEventListener("change", () => {
    const f = sigInput.files && sigInput.files[0];
    if (f) handleSignatureFile(f);
  });
}

function handleSignatureFile(file) {
  // Preview immediately
  sigSelected = true;
  if (overlayImg) overlayImg.src = URL.createObjectURL(file);

  // Hide Attach button (we upload automatically); show Sign only after backend confirms
  if (btnUpload) btnUpload.hidden = true;
  if (btnSign) btnSign.hidden = true;

  // Upload to backend
  const fd = new FormData();
  fd.append("recordId", session.recordId);
  fd.append("signature", file);

  startLoading("Uploading your signature…");
  fetch(api("/upload/signature"), {
    method: "POST",
    headers: authHeaders(),
    body: fd,
  })
    .then((r) => {
      if (!r.ok) throw new Error("Signature upload failed");
      // Enable Sign
      if (btnSign) {
        btnSign.hidden = false;
      }
    })
    .catch((e) => {
      console.error(e);
      alert("Signature upload failed");
      sigSelected = false;
      if (btnSign) btnSign.hidden = true;
    })
    .finally(stopLoading);
}

// ---------- sign ----------
async function onSign() {
  if (!pdfDoc || !overlay || !sigSelected) return;
  try {
    startLoading("Your document is being signed…");

    const canvas = canvases[overlayPage - 1];
    const cw = parseInt(canvas.style.width, 10) || canvas.width;
    const ch = parseInt(canvas.style.height, 10) || canvas.height;

    const leftPx = overlay.offsetLeft;
    const topPx = overlay.offsetTop;
    const widthPx = overlay.offsetWidth;

    const xPct = Math.max(0, Math.min(1, leftPx / cw));
    const yPct = Math.max(0, Math.min(1, topPx / ch));
    const widthPct = Math.max(0.01, Math.min(1, widthPx / cw));

    const body = {
      recordId: session.recordId,
      page: overlayPage,
      xPct,
      yPct,
      widthPct,
    };

    const res = await fetch(api("/compose"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(body),
    }).then((r) => r.json());

    if (res && res.signedDriveId) {
      // Show thank-you modal (no downloads / no JSON)
      const name = qs.get("name") || "Colleague";
      const docType = qs.get("docType") || "";
      const doneModal = document.getElementById("doneModal");
      const doneMsg = document.getElementById("doneMsg");
      const btnClose = document.getElementById("btn-close");

      if (doneMsg) {
        doneMsg.innerHTML = `
          <strong>Hi ${name},</strong><br/>
          Your ${docType || "document"} was signed successfully and securely stored.
          Our HR team has received a confirmation and will process it shortly.
        `;
      }
      if (btnClose) {
        btnClose.onclick = () => {
          doneModal.classList.add("hidden");
        };
      }
      if (doneModal) doneModal.classList.remove("hidden");
    } else {
      alert("Signing failed");
    }
  } catch (e) {
    console.error(e);
    alert("Signing failed");
  } finally {
    stopLoading();
  }
}
