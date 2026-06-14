/**
 * Campus Infrastructure AI Inspector — Frontend Application Logic
 * =====================================================================
 * Vanilla ES6+.  No frameworks.  Communicates with FastAPI backend.
 */

// ---------------------------------------------------------------------------
// Application State
// ---------------------------------------------------------------------------

const STATE = {
  activeModel: "3cls-s",
  activeClassGroup: "3cls",
  confidence: 0.25,
  iou: 0.45,
  sahiEnabled: false,
  sahiSliceSize: 704,
  allowedClasses: [],
  currentPanel: "dashboard",   // "dashboard" | "manifest" | "analytics"
  assets: [],                   // [{file, base64_or_url, is_video, defects, triage_level, advisory, latency, conf, iou, sahiEnabled, sahiSliceSize, defect_ratio}, ...]
  activeIndex: 0,
  sessionHistory: [],           // cumulative defect log across inspections (persisted to localStorage)
  runLog: [],                   // [{run, model, latency, defect_count, defect_ratio, triage_level, timestamp}, ...]
  inspectionCount: 0,           // how many assets have been processed
};

// ---------------------------------------------------------------------------
// localStorage Persistence (metrics only — no images)
// ---------------------------------------------------------------------------

const STORAGE_KEY_HISTORY = "campus_inspector_session_history";
const STORAGE_KEY_RUNLOG  = "campus_inspector_run_log";
const STORAGE_KEY_COUNT   = "campus_inspector_inspection_count";

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(STATE.sessionHistory));
    localStorage.setItem(STORAGE_KEY_RUNLOG,  JSON.stringify(STATE.runLog));
    localStorage.setItem(STORAGE_KEY_COUNT,   String(STATE.inspectionCount));
  } catch (_) { /* quota exceeded — silently ignore */ }
}

function loadFromStorage() {
  try {
    const h = localStorage.getItem(STORAGE_KEY_HISTORY);
    const r = localStorage.getItem(STORAGE_KEY_RUNLOG);
    const c = localStorage.getItem(STORAGE_KEY_COUNT);
    if (h) {
      STATE.sessionHistory = JSON.parse(h);
      // Migrate and normalize historical class names to title-case
      STATE.sessionHistory.forEach((item) => {
        if (item && item.class) {
          item.class = item.class
            .replace(/_/g, " ")
            .replace(/\b\w/g, (char) => char.toUpperCase());
        }
      });
    }
    if (r) STATE.runLog = JSON.parse(r);
    if (c) STATE.inspectionCount = parseInt(c, 10) || 0;
  } catch (_) { /* corrupt data — ignore */ }
}

function clearAllStoredData() {
  STATE.sessionHistory = [];
  STATE.runLog = [];
  STATE.inspectionCount = 0;
  localStorage.removeItem(STORAGE_KEY_HISTORY);
  localStorage.removeItem(STORAGE_KEY_RUNLOG);
  localStorage.removeItem(STORAGE_KEY_COUNT);
  populateTable();
  ANALYTICS.update();
  renderDiagnosticsExtras(null);
}

const SAHI_PIXEL_THRESHOLD = 1500000;

// ---------------------------------------------------------------------------
// DOM References (cached on DOMContentLoaded)
// ---------------------------------------------------------------------------

let D = {};

function cacheDomRefs() {
  D.sidebar = document.getElementById("sidebar");
  D.sidebarToggle = document.getElementById("sidebar-toggle");
  D.navBtns = document.querySelectorAll(".nav-btn");

  D.confSlider = document.getElementById("conf-slider");
  D.iouSlider = document.getElementById("iou-slider");
  D.confVal = document.getElementById("conf-val");
  D.iouVal = document.getElementById("iou-val");

  D.sahiContainer = document.getElementById("sahi-container");
  D.sahiCheckbox = document.getElementById("sahi-checkbox");
  D.sahiSliceSelect = document.getElementById("sahi-slice-select");
  D.sahiTooltip = document.getElementById("sahi-tooltip");
  D.sahiIntensityGroup = document.getElementById("sahi-intensity-group");

  D.classCheckboxes = document.querySelectorAll(".class-checkbox");
  D.groupBtns = document.querySelectorAll(".group-btn");

  D.detectBtn = document.getElementById("detect-btn");

  D.latencyDisplay = document.getElementById("latency-display");

  D.modelTabs = document.querySelectorAll(".model-tab");

  D.uploadZone = document.getElementById("upload-zone");
  D.fileInput = document.getElementById("file-input");
  D.actionBar = document.getElementById("action-bar");
  D.newInspectBtn = document.getElementById("new-inspect-btn");
  D.removeImageBtn = document.getElementById("remove-image-btn");

  D.outputContainer = document.getElementById("output-container");
  D.prevBtn = document.getElementById("prev-btn");
  D.nextBtn = document.getElementById("next-btn");
  D.carouselCounter = document.getElementById("carousel-counter");
  D.imageViewport = document.getElementById("image-viewport");
  D.outputImage = document.getElementById("output-image");
  D.outputVideo = document.getElementById("output-video");
  D.zoomHint = document.getElementById("zoom-hint");
  D.zoomResetBtn = document.getElementById("zoom-reset-btn");
  D.loadingSpinner = document.getElementById("loading-spinner");
  D.loadingText = document.getElementById("loading-text");
  D.errorToast = document.getElementById("error-toast");

  D.triageBanner = document.getElementById("triage-banner");
  D.triageLevel = document.getElementById("triage-level");
  D.triageAdvice = document.getElementById("triage-advice");

  D.statDefects = document.getElementById("stat-defects");
  D.statRatio = document.getElementById("stat-ratio");
  D.statAvgConf = document.getElementById("stat-avg-conf");
  D.statTopClass = document.getElementById("stat-top-class");
  D.statMaxArea = document.getElementById("stat-max-area");
  D.statSessionTotal = document.getElementById("stat-session-total");

  D.manifestPanel = document.getElementById("manifest-panel");
  D.manifestClose = document.getElementById("manifest-close");
  D.clearHistoryBtn = document.getElementById("clear-history-btn");
  D.defectTbody = document.getElementById("defect-tbody");
  D.manifestClassFilter = document.getElementById("manifest-class-filter");
  D.exportCsvBtn = document.getElementById("export-csv-btn");
  D.manifestFooter = document.getElementById("manifest-footer");

  D.analyticsPanel = document.getElementById("analytics-panel");
  D.analyticsClose = document.getElementById("analytics-close");
  D.clearAnalyticsBtn = document.getElementById("clear-analytics-btn");

  D.workspace = document.getElementById("main-workspace");
}

// ---------------------------------------------------------------------------
// Sidebar Toggle
// ---------------------------------------------------------------------------

function initSidebar() {
  D.sidebarToggle.addEventListener("click", () => {
    D.sidebar.classList.toggle("collapsed");
  });
}

// ---------------------------------------------------------------------------
// Navigation (Dashboard ↔ Manifest)
// ---------------------------------------------------------------------------

function initNav() {
  D.navBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const panel = btn.dataset.panel;

      // Update active button
      D.navBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      STATE.currentPanel = panel;

      // Hide all overlay panels first
      D.manifestPanel.classList.add("hidden");
      D.analyticsPanel.classList.add("hidden");
      D.workspace.style.display = "";

      if (panel === "manifest") {
        D.manifestPanel.classList.remove("hidden");
        D.workspace.style.display = "none";
      } else if (panel === "analytics") {
        D.analyticsPanel.classList.remove("hidden");
        D.workspace.style.display = "none";
        ANALYTICS.update();
      }
    });
  });

  D.manifestClose.addEventListener("click", () => _closeOverlay("dashboard"));
  D.analyticsClose.addEventListener("click", () => _closeOverlay("dashboard"));
}

function _closeOverlay(targetPanel) {
  D.manifestPanel.classList.add("hidden");
  D.analyticsPanel.classList.add("hidden");
  D.workspace.style.display = "";
  STATE.currentPanel = targetPanel;
  D.navBtns.forEach((b) => {
    b.classList.remove("active");
    if (b.dataset.panel === targetPanel) b.classList.add("active");
  });
}

// ---------------------------------------------------------------------------
// Sliders
// ---------------------------------------------------------------------------

function initSliders() {
  // Display initial values
  D.confVal.textContent = D.confSlider.value;
  D.iouVal.textContent = D.iouSlider.value;

  // Live update label on input
  D.confSlider.addEventListener("input", () => {
    STATE.confidence = parseFloat(D.confSlider.value);
    D.confVal.textContent = STATE.confidence.toFixed(2);
  });

  D.iouSlider.addEventListener("input", () => {
    STATE.iou = parseFloat(D.iouSlider.value);
    D.iouVal.textContent = STATE.iou.toFixed(2);
  });

  // Trigger re-inference on change (mouse release) — per active asset
  D.confSlider.addEventListener("change", () => {
    STATE.confidence = parseFloat(D.confSlider.value);
    const asset = STATE.assets[STATE.activeIndex];
    if (asset && asset.file) runInference();
  });

  D.iouSlider.addEventListener("change", () => {
    STATE.iou = parseFloat(D.iouSlider.value);
    const asset = STATE.assets[STATE.activeIndex];
    if (asset && asset.file) runInference();
  });
}

// ---------------------------------------------------------------------------
// Model Tabs
// ---------------------------------------------------------------------------

function initModelTabs() {
  D.modelTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      D.modelTabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      STATE.activeModel = tab.dataset.model;

      // Rebuild class pills for the newly selected model, then re-infer
      fetchAndRenderClasses(STATE.activeModel).then(() => {
        const asset = STATE.assets[STATE.activeIndex];
        if (asset && asset.file) runInference();
      });
    });
  });
}

// ---------------------------------------------------------------------------
// File Upload (Drag & Drop + Click)
// ---------------------------------------------------------------------------

function initUpload() {
  // Click to open file dialog (main upload zone)
  D.uploadZone.addEventListener("click", () => {
    D.fileInput.click();
  });

  // Click to open file dialog (new inspect button)
  D.newInspectBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    D.fileInput.click();
  });

  // Click to remove current asset
  D.removeImageBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    removeAsset();
  });

  D.fileInput.addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    if (files.length > 5) {
      showError("Maximum of 5 assets allowed per batch.");
      D.fileInput.value = "";
      return;
    }
    hideError();
    processQueue(files);
    D.fileInput.value = "";
  });

  // Drag & Drop
  D.uploadZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    D.uploadZone.classList.add("drag-over");
  });

  D.uploadZone.addEventListener("dragleave", () => {
    D.uploadZone.classList.remove("drag-over");
  });

  D.uploadZone.addEventListener("drop", (e) => {
    e.preventDefault();
    D.uploadZone.classList.remove("drag-over");
    const files = Array.from(e.dataTransfer.files || [])
      .filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
    if (files.length === 0) {
      showError("Please drop valid image or video files (JPG, PNG, MP4, MOV).");
      return;
    }
    if (files.length > 5) {
      showError("Maximum of 5 assets allowed per batch.");
      return;
    }
    hideError();
    processQueue(files);
  });
}

// ---------------------------------------------------------------------------
// Batch Queue Processor
// ---------------------------------------------------------------------------

async function processQueue(files) {
  const startIndex = STATE.assets.length;

  D.uploadZone.style.display = "none";
  D.outputContainer.classList.add("hidden");
  D.actionBar.classList.add("hidden");
  showLoading(true);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const progressMsg = `Processing ${i + 1} of ${files.length}&hellip;`;
    if (D.loadingText) D.loadingText.innerHTML = progressMsg;

    try {
      const data = await runSingleInference(file);
      STATE.assets.push({
        file,
        base64_or_url: data.is_video ? data.media_url : data.image_base64,
        is_video: !!data.is_video,
        defects: data.defects || [],
        triage_level: data.triage_level,
        advisory: data.advisory_text,
        latency: data.latency_ms,
        conf: STATE.confidence,
        iou: STATE.iou,
        defect_ratio: data.defect_ratio,
        defect_count: data.defect_count,
      });

      // Log defects to session history
      STATE.inspectionCount += 1;
      const runId = STATE.inspectionCount;
      const enriched = (data.defects || []).map((d) => ({ ...d, inspection_run: runId }));
      STATE.sessionHistory.push(...enriched);

      // Log run-level metadata
      STATE.runLog.push({
        run: runId,
        model: STATE.activeModel,
        latency: data.latency_ms,
        defect_count: data.defect_count || 0,
        defect_ratio: data.defect_ratio || 0,
        triage_level: data.triage_level,
        timestamp: Date.now(),
      });

      saveToStorage();
      populateTable();
      ANALYTICS.update();
    } catch (err) {
      showError(`Asset ${i + 1}: ${err.message || "inference failed"}`);
    }
  }

  showLoading(false);

  // If at least one asset processed, show the first new one
  if (STATE.assets.length > startIndex) {
    STATE.activeIndex = startIndex;
    renderActiveAsset();
  } else {
    D.uploadZone.style.display = "";
  }
}

// ---------------------------------------------------------------------------
// Single-Asset Inference (used by batch queue & re-inference)
// ---------------------------------------------------------------------------

async function runSingleInference(file) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("model_name", STATE.activeModel);
  formData.append("conf_threshold", STATE.confidence);
  formData.append("iou_threshold", STATE.iou);
  formData.append("sahi_enabled", STATE.sahiEnabled);
  formData.append("sahi_slice_size", STATE.sahiSliceSize);
  formData.append("allowed_classes", STATE.allowedClasses.join(","));

  const response = await fetch("/api/detect", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.detail || `Server error (HTTP ${response.status})`);
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Zoom & Pan on the output image
// ---------------------------------------------------------------------------

const ZOOM = {
  scale: 1,
  minScale: 0.3,
  maxScale: 6,
  panX: 0,
  panY: 0,
  isPanning: false,
  startX: 0,
  startY: 0,
};

function applyTransform() {
  if (!D.outputImage) return;
  D.outputImage.style.transform =
    `translate(${ZOOM.panX}px, ${ZOOM.panY}px) scale(${ZOOM.scale})`;
  D.zoomHint.textContent = `${Math.round(ZOOM.scale * 100)}%`;
}

function resetZoomPan() {
  ZOOM.scale = 1;
  ZOOM.panX = 0;
  ZOOM.panY = 0;
  ZOOM.isPanning = false;
  applyTransform();
}

function clampPan() {
  if (!D.imageViewport || !D.outputImage) return;
  const vpW = D.imageViewport.clientWidth;
  const vpH = D.imageViewport.clientHeight;
  const imgW = D.outputImage.naturalWidth * ZOOM.scale;
  const imgH = D.outputImage.naturalHeight * ZOOM.scale;

  const maxX = Math.max(0, (imgW - vpW) / 2);
  const maxY = Math.max(0, (imgH - vpH) / 2);

  ZOOM.panX = Math.max(-maxX, Math.min(maxX, ZOOM.panX));
  ZOOM.panY = Math.max(-maxY, Math.min(maxY, ZOOM.panY));
}

function initZoomPan() {
  if (!D.imageViewport) return;

  // Mouse wheel → zoom
  D.imageViewport.addEventListener("wheel", (e) => {
    // Skip zoom when video is showing
    if (D.outputVideo.style.display !== "none") return;
    e.preventDefault();
    const rect = D.imageViewport.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const oldScale = ZOOM.scale;
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    ZOOM.scale = Math.max(
      ZOOM.minScale,
      Math.min(ZOOM.maxScale, ZOOM.scale + delta)
    );

    // Zoom toward cursor
    const scaleChange = ZOOM.scale / oldScale;
    ZOOM.panX = mouseX - scaleChange * (mouseX - ZOOM.panX);
    ZOOM.panY = mouseY - scaleChange * (mouseY - ZOOM.panY);
    clampPan();
    applyTransform();
  }, { passive: false });

  // Mouse down → start pan
  D.imageViewport.addEventListener("mousedown", (e) => {
    if (D.outputVideo.style.display !== "none") return;
    ZOOM.isPanning = true;
    ZOOM.startX = e.clientX - ZOOM.panX;
    ZOOM.startY = e.clientY - ZOOM.panY;
    D.imageViewport.classList.add("panning");
  });

  // Mouse move → pan
  window.addEventListener("mousemove", (e) => {
    if (!ZOOM.isPanning) return;
    ZOOM.panX = e.clientX - ZOOM.startX;
    ZOOM.panY = e.clientY - ZOOM.startY;
    clampPan();
    applyTransform();
  });

  // Mouse up → stop pan
  window.addEventListener("mouseup", () => {
    if (ZOOM.isPanning) {
      ZOOM.isPanning = false;
      D.imageViewport.classList.remove("panning");
    }
  });

  // Double-click → reset zoom
  D.imageViewport.addEventListener("dblclick", () => {
    resetZoomPan();
  });

  // Reset button
  D.zoomResetBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    resetZoomPan();
  });
}

// ---------------------------------------------------------------------------
// Re-Inference (triggered by slider/model change on active asset)
// ---------------------------------------------------------------------------

async function runInference() {
  const idx = STATE.activeIndex;
  const asset = STATE.assets[idx];
  if (!asset || !asset.file) return;

  hideError();
  D.loadingText.textContent = "Running inference...";
  showLoading(true);

  try {
    const data = await runSingleInference(asset.file);

    // Overwrite this asset slot with fresh results
    STATE.assets[idx] = {
      file: asset.file,
      base64_or_url: data.is_video ? data.media_url : data.image_base64,
      is_video: !!data.is_video,
      defects: data.defects || [],
      triage_level: data.triage_level,
      advisory: data.advisory_text,
      latency: data.latency_ms,
      conf: STATE.confidence,
      iou: STATE.iou,
      sahiEnabled: STATE.sahiEnabled,
      sahiSliceSize: STATE.sahiSliceSize,
      allowedClasses: [...STATE.allowedClasses],
      defect_ratio: data.defect_ratio,
      defect_count: data.defect_count,
    };

    // Log new run to session history
    STATE.inspectionCount += 1;
    const runId = STATE.inspectionCount;
    const enriched = (data.defects || []).map((d) => ({ ...d, inspection_run: runId }));
    STATE.sessionHistory.push(...enriched);

    // Log run-level metadata
    STATE.runLog.push({
      run: runId,
      model: STATE.activeModel,
      latency: data.latency_ms,
      defect_count: data.defect_count || 0,
      defect_ratio: data.defect_ratio || 0,
      triage_level: data.triage_level,
      timestamp: Date.now(),
    });

    saveToStorage();
    populateTable();
    ANALYTICS.update();

    renderActiveAsset();
  } catch (err) {
    showError(err.message || "Re-inference failed.");
  } finally {
    showLoading(false);
  }
}

// ---------------------------------------------------------------------------
// Carousel Render — sync entire UI to STATE.assets[STATE.activeIndex]
// ---------------------------------------------------------------------------

function renderActiveAsset() {
  const total = STATE.assets.length;
  if (total === 0) {
    // Reset to empty upload state
    D.uploadZone.style.display = "";
    D.outputContainer.classList.add("hidden");
    D.actionBar.classList.add("hidden");
    D.latencyDisplay.textContent = "--";
    D.statDefects.textContent = "0";
    D.statRatio.textContent = "0.00%";

    // Disable SAHI when no assets
    D.sahiContainer.classList.add("disabled");
    D.sahiCheckbox.checked = false;
    D.sahiIntensityGroup.classList.add("hidden");
    STATE.sahiEnabled = false;
    D.sahiTooltip.textContent = "Upload an asset to enable Deep Scan.";

    // Disable detect button
    D.detectBtn.disabled = true;
    return;
  }

  const asset = STATE.assets[STATE.activeIndex];
  if (!asset) return;

  // Show output UI
  D.uploadZone.style.display = "none";
  D.actionBar.classList.remove("hidden");
  D.outputContainer.classList.remove("hidden");

  // Enable detect button
  D.detectBtn.disabled = false;

  // --- Carousel arrows & counter ----------------------------------------
  D.prevBtn.disabled = STATE.activeIndex === 0;
  D.nextBtn.disabled = STATE.activeIndex === total - 1;

  // Hide arrows if only 1 asset
  D.prevBtn.style.display = total <= 1 ? "none" : "";
  D.nextBtn.style.display = total <= 1 ? "none" : "";
  D.carouselCounter.textContent = `${STATE.activeIndex + 1} / ${total}`;
  D.carouselCounter.style.display = total <= 1 ? "none" : "";

  // --- Media ------------------------------------------------------------
  if (asset.is_video) {
    D.outputImage.src = "";
    D.outputImage.style.display = "none";
    D.outputVideo.src = asset.base64_or_url;
    D.outputVideo.style.display = "";
    D.zoomHint.style.display = "none";
    D.zoomResetBtn.style.display = "none";
    D.imageViewport.style.cursor = "default";
  } else {
    D.outputVideo.src = "";
    D.outputVideo.style.display = "none";
    D.outputImage.style.display = "";
    D.outputImage.src = asset.base64_or_url;
    D.zoomHint.style.display = "";
    D.zoomResetBtn.style.display = "";
    D.imageViewport.style.cursor = "grab";
    resetZoomPan();
  }

  // --- Sliders: sync to this asset's saved params -----------------------
  D.confSlider.value = asset.conf;
  D.confVal.textContent = asset.conf.toFixed(2);
  STATE.confidence = asset.conf;

  D.iouSlider.value = asset.iou;
  D.iouVal.textContent = asset.iou.toFixed(2);
  STATE.iou = asset.iou;

  // --- SAHI: sync toggle & dropdown to this asset's saved params --------
  STATE.sahiEnabled = !!asset.sahiEnabled;
  STATE.sahiSliceSize = asset.sahiSliceSize || 704;
  D.sahiCheckbox.checked = STATE.sahiEnabled;
  D.sahiSliceSelect.value = String(STATE.sahiSliceSize);
  D.sahiIntensityGroup.classList.toggle("hidden", !STATE.sahiEnabled);

  // --- Class filters: sync checkboxes to this asset's saved state ------
  STATE.allowedClasses = (asset.allowedClasses && asset.allowedClasses.length)
    ? [...asset.allowedClasses]
    : Array.from(D.classCheckboxes).map((cb) => parseInt(cb.value, 10));
  D.classCheckboxes.forEach((cb) => {
    cb.checked = STATE.allowedClasses.includes(parseInt(cb.value, 10));
  });

  // --- SAHI: dynamic lock based on asset type & resolution --------------
  applySahiLock(asset);

  // --- Latency, triage, stats -------------------------------------------
  D.latencyDisplay.textContent = asset.latency;

  const level = asset.triage_level;
  D.triageBanner.classList.remove("triage-critical", "triage-attention", "triage-monitor");
  D.triageBanner.classList.add(`triage-${level}`);

  const triageIcon = D.triageBanner.querySelector(".triage-icon");
  switch (level) {
    case "critical":
      triageIcon.textContent = "error";
      D.triageLevel.textContent = "CRITICAL";
      break;
    case "attention":
      triageIcon.textContent = "warning";
      D.triageLevel.textContent = "ATTENTION";
      break;
    default:
      triageIcon.textContent = "check_circle";
      D.triageLevel.textContent = "MONITOR";
  }

  D.triageAdvice.textContent = asset.advisory;
  D.statDefects.textContent = asset.defect_count != null ? asset.defect_count : asset.defects.length;
  D.statRatio.textContent = `${((asset.defect_ratio || 0) * 100).toFixed(2)}%`;
  renderDiagnosticsExtras(asset);
}

// ---------------------------------------------------------------------------
// Remove current asset
// ---------------------------------------------------------------------------

function removeAsset() {
  if (STATE.assets.length === 0) return;

  STATE.assets.splice(STATE.activeIndex, 1);

  if (STATE.assets.length === 0) {
    STATE.activeIndex = 0;
    renderActiveAsset();  // resets to upload zone
    return;
  }

  // Clamp index
  if (STATE.activeIndex >= STATE.assets.length) {
    STATE.activeIndex = STATE.assets.length - 1;
  }
  renderActiveAsset();
}

// ---------------------------------------------------------------------------
// Enhanced Diagnostics — extra stat cards for the current asset
// ---------------------------------------------------------------------------

function renderDiagnosticsExtras(asset) {
  if (!D.statAvgConf) return;
  if (!asset || !asset.defects || asset.defects.length === 0) {
    D.statAvgConf.textContent = "--";
    D.statTopClass.textContent = "--";
    D.statMaxArea.textContent = "--";
  } else {
    // Avg confidence
    const avgConf = asset.defects.reduce((s, d) => s + d.confidence, 0) / asset.defects.length;
    D.statAvgConf.textContent = `${(avgConf * 100).toFixed(1)}%`;

    // Top defect class
    const classCounts = {};
    asset.defects.forEach((d) => {
      classCounts[d.class] = (classCounts[d.class] || 0) + 1;
    });
    const topClass = Object.entries(classCounts).sort((a, b) => b[1] - a[1])[0][0];
    D.statTopClass.textContent = topClass.replace(/_/g, " ");

    // Largest defect area
    const maxArea = Math.max(...asset.defects.map((d) => d.area_px));
    D.statMaxArea.textContent = maxArea.toLocaleString();
  }

  // Session total defects (across all runs)
  if (D.statSessionTotal) {
    D.statSessionTotal.textContent = STATE.sessionHistory.length;
  }
}

// ---------------------------------------------------------------------------
// Manifest: sort state
// ---------------------------------------------------------------------------

const SORT = { col: null, dir: 1 }; // dir: 1=asc, -1=desc

function populateTable() {
  D.defectTbody.innerHTML = "";

  // Build unique class list for filter dropdown
  const classSet = new Set(STATE.sessionHistory.map((d) => d.class));
  const currentFilter = D.manifestClassFilter ? D.manifestClassFilter.value : "all";
  // Rebuild options
  if (D.manifestClassFilter) {
    D.manifestClassFilter.innerHTML = `<option value="all">All Classes</option>`;
    [...classSet].sort().forEach((cls) => {
      const opt = document.createElement("option");
      opt.value = cls;
      opt.textContent = cls.replace(/_/g, " ");
      if (cls === currentFilter) opt.selected = true;
      D.manifestClassFilter.appendChild(opt);
    });
  }

  // Filter
  let rows = [...STATE.sessionHistory];
  if (currentFilter && currentFilter !== "all") {
    rows = rows.filter((d) => d.class === currentFilter);
  }

  // Sort
  if (SORT.col) {
    rows.sort((a, b) => {
      const av = a[SORT.col];
      const bv = b[SORT.col];
      return typeof av === "string"
        ? av.localeCompare(bv) * SORT.dir
        : (av - bv) * SORT.dir;
    });
  }

  if (rows.length === 0) {
    D.defectTbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="6">No defects logged. Run an inspection to populate.</td>
      </tr>`;
    _updateManifestFooter(0, 0);
    return;
  }

  rows.forEach((d) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="mono">#${d.inspection_run}</span></td>
      <td><span class="mono">${d.id}</span></td>
      <td>
        <span class="defect-badge defect-${d.class.toLowerCase().replace(/[\s-]/g, '_')}">
          ${d.class}
        </span>
      </td>
      <td><span class="mono">${(d.confidence * 100).toFixed(1)}%</span></td>
      <td><span class="mono">${d.area_px.toLocaleString()}</span></td>
      <td class="mono" style="font-size:12px;color:var(--text-secondary);">
        [${d.x1}, ${d.y1}, ${d.x2}, ${d.y2}]</td>`;
    D.defectTbody.appendChild(tr);
  });

  // Footer summary
  const avgConf = rows.reduce((s, d) => s + d.confidence, 0) / rows.length;
  _updateManifestFooter(rows.length, avgConf);
}

function _updateManifestFooter(count, avgConf) {
  if (!D.manifestFooter) return;
  if (count === 0) {
    D.manifestFooter.innerHTML = "";
    return;
  }
  D.manifestFooter.innerHTML =
    `Showing <span>${count}</span> defects &nbsp;·&nbsp;
     Avg confidence <span>${(avgConf * 100).toFixed(1)}%</span> &nbsp;·&nbsp;
     Total runs <span>${STATE.runLog.length}</span>`;
}



// ---------------------------------------------------------------------------
// Loading & Error Helpers
// ---------------------------------------------------------------------------

function showLoading(visible) {
  if (visible) {
    D.loadingSpinner.classList.remove("hidden");
    D.outputContainer.classList.add("hidden");
    D.actionBar.classList.add("hidden");
    D.uploadZone.style.display = "none";
  } else {
    D.loadingSpinner.classList.add("hidden");
  }
}

function showError(message) {
  D.errorToast.textContent = message;
  D.errorToast.classList.remove("hidden");
  D.uploadZone.style.display = "";
  D.outputContainer.classList.add("hidden");
  D.actionBar.classList.add("hidden");
}

function hideError() {
  D.errorToast.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Class Group Toggle (3-class ↔ 6-class)
// ---------------------------------------------------------------------------

function initClassGroupToggle() {
  D.groupBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const group = btn.dataset.group;
      if (group === STATE.activeClassGroup) return;
      STATE.activeClassGroup = group;

      D.groupBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      // Show only model tabs for this group
      D.modelTabs.forEach((tab) => {
        tab.style.display = tab.dataset.group === group ? "" : "none";
      });

      // Map current size to equivalent in new group; v5 only exists in 3cls so falls back to s
      const sizeMap = { "3cls-s": "s", "3cls-m": "m", "3cls-v5": "v5", "6cls-s": "s", "6cls-m": "m" };
      const currentSize = sizeMap[STATE.activeModel] || "s";
      const preferred = `${group}-${currentSize}`;
      const target = document.querySelector(`[data-model="${preferred}"]`) ? preferred : `${group}-s`;

      D.modelTabs.forEach((t) => t.classList.remove("active"));
      document.querySelector(`[data-model="${target}"]`).classList.add("active");
      STATE.activeModel = target;

      fetchAndRenderClasses(STATE.activeModel).then(() => {
        const asset = STATE.assets[STATE.activeIndex];
        if (asset && asset.file) runInference();
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Class Toggle Filters
// ---------------------------------------------------------------------------

function initClassToggles() {
  // Re-query so this works after dynamic pill injection
  D.classCheckboxes = document.querySelectorAll(".class-checkbox");

  D.classCheckboxes.forEach((cb) => {
    cb.addEventListener("change", () => {
      STATE.allowedClasses = Array.from(D.classCheckboxes)
        .filter((c) => c.checked)
        .map((c) => parseInt(c.value, 10));

      // Prevent unchecking all — re-check at least one
      if (STATE.allowedClasses.length === 0) {
        cb.checked = true;
        STATE.allowedClasses = [parseInt(cb.value, 10)];
      }

      // Re-run inference on active asset immediately
      const asset = STATE.assets[STATE.activeIndex];
      if (asset && asset.file) runInference();
    });
  });
}

// ---------------------------------------------------------------------------
// Dynamic Class Pills (driven by /api/model-info)
// ---------------------------------------------------------------------------

async function fetchAndRenderClasses(modelName) {
  try {
    const res = await fetch(`/api/model-info?model_name=${modelName}`);
    if (!res.ok) return;
    const data = await res.json();

    const container = document.getElementById("filter-pills-container");
    container.innerHTML = "";

    STATE.allowedClasses = data.classes.map((c) => c.id);

    data.classes.forEach(({ id, name }) => {
      const cssName = name.toLowerCase().replace(/[_\s]/g, "-");

      const label = document.createElement("label");
      label.className = `filter-pill filter-${cssName}`;

      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "class-checkbox";
      input.value = String(id);
      input.checked = true;

      const span = document.createElement("span");
      span.className = "pill-text";
      span.textContent = name.replace(/_/g, " ");

      label.appendChild(input);
      label.appendChild(span);
      container.appendChild(label);
    });

    // Re-cache and re-bind after DOM update
    initClassToggles();
  } catch (e) {
    // Pills stay empty; inference still works (backend defaults to all classes)
  }
}

// ---------------------------------------------------------------------------
// SAHI Toggle & Lock Logic
// ---------------------------------------------------------------------------

function initSahiToggle() {
  D.sahiCheckbox.addEventListener("change", () => {
    STATE.sahiEnabled = D.sahiCheckbox.checked;
    D.sahiIntensityGroup.classList.toggle("hidden", !STATE.sahiEnabled);
  });

  D.sahiSliceSelect.addEventListener("change", () => {
    STATE.sahiSliceSize = parseInt(D.sahiSliceSelect.value, 10);
  });
}

function applySahiLock(asset) {
  const container = D.sahiContainer;
  const tooltip = D.sahiTooltip;
  const defaultTooltip = "Slices high-res assets to detect micro-anomalies.";

  if (!asset) {
    container.classList.add("disabled");
    tooltip.textContent = defaultTooltip;
    return;
  }

  // Video: SAHI not available
  if (asset.is_video) {
    container.classList.add("disabled");
    D.sahiCheckbox.checked = false;
    D.sahiIntensityGroup.classList.add("hidden");
    STATE.sahiEnabled = false;
    tooltip.textContent = "SAHI is not available for video telemetry.";
    return;
  }

  // Image: check resolution via the base64 data URI
  const src = asset.base64_or_url;
  if (!src || !src.startsWith("data:image")) {
    // Can't determine resolution — leave as-is (edge case)
    container.classList.remove("disabled");
    tooltip.textContent = defaultTooltip;
    return;
  }

  const img = new Image();
  img.onload = () => {
    const totalPixels = img.naturalWidth * img.naturalHeight;
    if (totalPixels < SAHI_PIXEL_THRESHOLD) {
      container.classList.add("disabled");
      D.sahiCheckbox.checked = false;
      D.sahiIntensityGroup.classList.add("hidden");
      STATE.sahiEnabled = false;
      tooltip.textContent = "Image resolution optimal. Deep Scan unnecessary.";
    } else {
      container.classList.remove("disabled");
      tooltip.textContent = defaultTooltip;
      D.sahiCheckbox.checked = STATE.sahiEnabled;
      D.sahiIntensityGroup.classList.toggle("hidden", !STATE.sahiEnabled);
    }
  };
  img.src = src;
}

// ---------------------------------------------------------------------------
// Carousel Navigation
// ---------------------------------------------------------------------------

function initCarousel() {
  D.prevBtn.addEventListener("click", () => {
    if (STATE.activeIndex > 0) {
      STATE.activeIndex -= 1;
      renderActiveAsset();
    }
  });

  D.nextBtn.addEventListener("click", () => {
    if (STATE.activeIndex < STATE.assets.length - 1) {
      STATE.activeIndex += 1;
      renderActiveAsset();
    }
  });

  // Keyboard arrows
  document.addEventListener("keydown", (e) => {
    if (STATE.assets.length <= 1) return;
    if (STATE.currentPanel !== "dashboard") return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (STATE.activeIndex > 0) {
        STATE.activeIndex -= 1;
        renderActiveAsset();
      }
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (STATE.activeIndex < STATE.assets.length - 1) {
        STATE.activeIndex += 1;
        renderActiveAsset();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Manifest: table sorting & class filter & CSV export
// ---------------------------------------------------------------------------

function initManifestControls() {
  // Sortable column headers
  document.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (SORT.col === col) {
        SORT.dir *= -1;
      } else {
        SORT.col = col;
        SORT.dir = 1;
      }
      // Update header visual
      document.querySelectorAll("th.sortable").forEach((h) => {
        h.classList.remove("sort-asc", "sort-desc");
      });
      th.classList.add(SORT.dir === 1 ? "sort-asc" : "sort-desc");
      populateTable();
    });
  });

  // Class filter
  if (D.manifestClassFilter) {
    D.manifestClassFilter.addEventListener("change", () => populateTable());
  }

  // CSV Export
  if (D.exportCsvBtn) {
    D.exportCsvBtn.addEventListener("click", exportCSV);
  }
}

function exportCSV() {
  if (STATE.sessionHistory.length === 0) return;

  const headers = ["Run", "ID", "Class", "Confidence", "Area_px", "x1", "y1", "x2", "y2"];
  const rows = STATE.sessionHistory.map((d) => [
    d.inspection_run,
    d.id,
    d.class,
    d.confidence,
    d.area_px,
    d.x1,
    d.y1,
    d.x2,
    d.y2,
  ]);

  const csv = [headers, ...rows]
    .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `campus_inspector_defects_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// ANALYTICS MODULE — Chart.js powered
// ---------------------------------------------------------------------------

const CHART_DEFAULTS = {
  plugins: {
    legend: {
      labels: {
        color: "#9ca3af",
        font: { family: "'Plus Jakarta Sans', sans-serif", size: 12 },
        boxWidth: 12,
        padding: 12,
      },
    },
    tooltip: {
      backgroundColor: "#111827",
      borderColor: "#1f2937",
      borderWidth: 1,
      titleColor: "#f8fafc",
      bodyColor: "#9ca3af",
      padding: 10,
    },
  },
  scales: {
    x: {
      ticks: { color: "#6b7280", font: { family: "'JetBrains Mono', monospace", size: 11 } },
      grid:  { color: "rgba(31,41,55,0.8)" },
    },
    y: {
      ticks: { color: "#6b7280", font: { family: "'JetBrains Mono', monospace", size: 11 } },
      grid:  { color: "rgba(31,41,55,0.8)" },
    },
  },
};

const CLASS_COLOUR_MAP = {
  crack:                 "#ff4444",
  delamination:          "#00ff88",
  stain:                 "#ffa500",
  exposed_reinforcement: "#ff8c00",
  rust_stain:            "#ffc800",
  spalling:              "#cc00ff",
  efflorescence:         "#c8ff00",
};

const ANALYTICS = (function () {
  let charts = {};

  function _getOrCreate(id, config) {
    if (charts[id]) {
      charts[id].destroy();
    }
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    charts[id] = new Chart(canvas, config);
    return charts[id];
  }

  function _empty(containerId, message = "Run inspections to see analytics") {
    const canvas = document.getElementById(containerId);
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (parent) {
      parent.innerHTML = `<div class="analytics-empty"><span class="material-symbols-rounded">bar_chart</span>${message}</div>`;
    }
  }

  function updateSummaryStrip() {
    const runs = STATE.runLog.length;
    const defects = STATE.sessionHistory.length;
    const avgConf = defects > 0
      ? STATE.sessionHistory.reduce((s, d) => s + d.confidence, 0) / defects
      : null;
    const avgLat = runs > 0
      ? STATE.runLog.reduce((s, r) => s + r.latency, 0) / runs
      : null;
    const criticalRuns = STATE.runLog.filter((r) => r.triage_level === "critical").length;

    const el = (id) => document.getElementById(id);
    el("achip-runs").textContent     = runs;
    el("achip-defects").textContent  = defects;
    el("achip-avg-conf").textContent = avgConf != null ? `${(avgConf * 100).toFixed(1)}%` : "--";
    el("achip-avg-lat").textContent  = avgLat  != null ? Math.round(avgLat) : "--";
    el("achip-critical").textContent = criticalRuns;

    const critWrap = document.getElementById("achip-critical-wrap");
    if (critWrap) {
      critWrap.classList.toggle("zero", criticalRuns === 0);
    }
  }

  function chartClassDist() {
    if (STATE.sessionHistory.length === 0) { _empty("chart-class-dist"); return; }

    const counts = {};
    STATE.sessionHistory.forEach((d) => {
      counts[d.class] = (counts[d.class] || 0) + 1;
    });
    const labels = Object.keys(counts);
    const data   = labels.map((k) => counts[k]);
    const colors = labels.map((k) => CLASS_COLOUR_MAP[k.toLowerCase()] || "#9ca3af");

    _getOrCreate("chart-class-dist", {
      type: "doughnut",
      data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0, hoverOffset: 8 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        cutout: "62%",
        plugins: { ...CHART_DEFAULTS.plugins, legend: { ...CHART_DEFAULTS.plugins.legend, position: "right" } },
      },
    });
  }

  function chartConfHist() {
    if (STATE.sessionHistory.length === 0) { _empty("chart-conf-hist"); return; }

    const buckets = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 0.0-0.1, 0.1-0.2 ... 0.9-1.0
    STATE.sessionHistory.forEach((d) => {
      const idx = Math.min(9, Math.floor(d.confidence * 10));
      buckets[idx]++;
    });
    const labels = buckets.map((_, i) => `${(i * 0.1).toFixed(1)}–${((i + 1) * 0.1).toFixed(1)}`);

    _getOrCreate("chart-conf-hist", {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "# Detections",
          data: buckets,
          backgroundColor: "rgba(56,189,248,0.65)",
          borderColor: "#38bdf8",
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { ...CHART_DEFAULTS.plugins, legend: { display: false } },
        scales: CHART_DEFAULTS.scales,
      },
    });
  }

  function chartTriageHist() {
    if (STATE.runLog.length === 0) { _empty("chart-triage-hist"); return; }

    const labels  = STATE.runLog.map((r) => `#${r.run}`);
    const numericLevel = (t) => t === "critical" ? 3 : t === "attention" ? 2 : 1;
    const colors  = STATE.runLog.map((r) =>
      r.triage_level === "critical" ? "#dc2626" :
      r.triage_level === "attention" ? "#f59e0b" : "#10b981"
    );

    _getOrCreate("chart-triage-hist", {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Triage Level",
          data: STATE.runLog.map((r) => numericLevel(r.triage_level)),
          backgroundColor: colors,
          borderWidth: 0,
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { ...CHART_DEFAULTS.plugins, legend: { display: false } },
        scales: {
          ...CHART_DEFAULTS.scales,
          y: {
            ...CHART_DEFAULTS.scales.y,
            min: 0, max: 3.5,
            ticks: {
              ...CHART_DEFAULTS.scales.y.ticks,
              stepSize: 1,
              callback: (v) => [" ", "Monitor", "Attention", "Critical"][v] || "",
            },
          },
        },
      },
    });
  }

  function chartPerRun() {
    if (STATE.runLog.length === 0) { _empty("chart-per-run"); return; }

    const labels = STATE.runLog.map((r) => `Run #${r.run}`);

    _getOrCreate("chart-per-run", {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Defect Count",
            data: STATE.runLog.map((r) => r.defect_count),
            backgroundColor: "rgba(56,189,248,0.65)",
            borderColor: "#38bdf8",
            borderWidth: 1,
            borderRadius: 4,
            yAxisID: "yCount",
          },
          {
            label: "Defect Ratio (%)",
            data: STATE.runLog.map((r) => (r.defect_ratio * 100).toFixed(2)),
            type: "line",
            borderColor: "#f59e0b",
            backgroundColor: "rgba(245,158,11,0.15)",
            borderWidth: 2,
            pointRadius: 4,
            pointBackgroundColor: "#f59e0b",
            tension: 0.3,
            fill: true,
            yAxisID: "yRatio",
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: CHART_DEFAULTS.plugins,
        scales: {
          x: CHART_DEFAULTS.scales.x,
          yCount: {
            ...CHART_DEFAULTS.scales.y,
            position: "left",
            title: { display: true, text: "Count", color: "#38bdf8", font: { size: 11 } },
          },
          yRatio: {
            ...CHART_DEFAULTS.scales.y,
            position: "right",
            grid: { drawOnChartArea: false },
            title: { display: true, text: "Ratio (%)", color: "#f59e0b", font: { size: 11 } },
          },
        },
      },
    });
  }

  function chartLatencyByModel() {
    if (STATE.runLog.length === 0) { _empty("chart-latency-model"); return; }

    const byModel = {};
    STATE.runLog.forEach((r) => {
      if (!byModel[r.model]) byModel[r.model] = [];
      byModel[r.model].push(r.latency);
    });

    const labels  = Object.keys(byModel);
    const avgLats = labels.map((m) => {
      const arr = byModel[m];
      return Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
    });
    const modelColors = ["#38bdf8", "#f59e0b", "#10b981", "#b400ff", "#ff4444"];

    _getOrCreate("chart-latency-model", {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Avg Latency (ms)",
          data: avgLats,
          backgroundColor: labels.map((_, i) => modelColors[i % modelColors.length] + "aa"),
          borderColor: labels.map((_, i) => modelColors[i % modelColors.length]),
          borderWidth: 1,
          borderRadius: 6,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { ...CHART_DEFAULTS.plugins, legend: { display: false } },
        scales: CHART_DEFAULTS.scales,
      },
    });
  }

  function update() {
    updateSummaryStrip();
    chartClassDist();
    chartConfHist();
    chartTriageHist();
    chartPerRun();
    chartLatencyByModel();
  }

  return { update };
})();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  loadFromStorage();
  cacheDomRefs();
  initSidebar();
  initNav();
  initSliders();
  initModelTabs();
  initUpload();
  initZoomPan();
  initClassGroupToggle();
  initSahiToggle();
  initCarousel();
  initManifestControls();
  fetchAndRenderClasses(STATE.activeModel);

  // Restore table from storage
  populateTable();
  renderDiagnosticsExtras(null);

  // Detect button — manually trigger re-inference on active asset
  D.detectBtn.addEventListener("click", () => {
    const asset = STATE.assets[STATE.activeIndex];
    if (asset && asset.file) runInference();
  });

  // Clear-history button (inside manifest panel) — wipes storage too
  D.clearHistoryBtn.addEventListener("click", () => {
    clearAllStoredData();
  });

  // Clear All Data button (inside analytics panel)
  D.clearAnalyticsBtn.addEventListener("click", () => {
    if (confirm("Clear all stored inspection data? This cannot be undone.")) {
      clearAllStoredData();
    }
  });
});
