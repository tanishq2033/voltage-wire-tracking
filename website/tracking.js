// =====================================================================
// TRACKING MODULE
// Finds the ArUco marker in every camera frame and reports its pixel
// position, its four corners and an ACTIVE / LOST state.
//
// Two detectors are used:
//   1. OpenCV server (aruco_tracker_server.py) - preferred, much more
//      accurate. The browser POSTs frames and uses the reply directly
//      (no second polling request, so there is no extra lag).
//   2. js-aruco in the browser - automatic fallback whenever the server
//      is not running / not reachable.
//
// All positions are in the pixel coordinates of the camera frame
// (state.frameWidth x state.frameHeight).
// =====================================================================

const Tracking = (() => {
  const detector = new AR.Detector();

  const SERVER_URL = "http://localhost:8765";
  const SEND_INTERVAL_MS = 80;     // how often frames are sent to the server
  const SERVER_ALIVE_MS = 1500;    // server counts as "alive" if it replied this recently
  const LOST_GRACE_MS = 350;       // keep the last position this long after a missed frame
  const JS_MAX_WIDTH = 640;        // browser detector runs on a downscaled frame
  const JS_INTERVAL_MS = 60;

  const state = {
    active: false,
    pixelX: null,
    pixelY: null,
    corners: null,
    frameWidth: 0,
    frameHeight: 0,
    markerId: null,
    lostFrames: 0,
    mode: "none",                  // "server" | "browser" | "none"
    pose: { R: null, t: null },    // kept for compatibility, not used any more
  };

  const server = { lastReply: 0, detection: null };
  let lastSeenAt = 0;
  let jsDetection = null;
  let lastJsAt = 0;
  const smoothedCorners = { value: null };

  const sendCanvas = document.createElement("canvas");
  const sendCtx = sendCanvas.getContext("2d");
  const jsCanvas = document.createElement("canvas");
  const jsCtx = jsCanvas.getContext("2d", { willReadFrequently: true });

  // ---------- helpers ----------
  function sourceSize(source) {
    if (!source) return { w: 0, h: 0 };
    return CameraModule.isStatic()
      ? { w: source.naturalWidth || source.width, h: source.naturalHeight || source.height }
      : { w: source.videoWidth, h: source.videoHeight };
  }

  function perimeter(c) {
    let p = 0;
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      p += Math.hypot(a.x - b.x, a.y - b.y);
    }
    return p;
  }

  // Centre of a (possibly perspective-distorted) square = intersection of its diagonals.
  function centerOf(c) {
    const x1 = c[0].x, y1 = c[0].y, x2 = c[2].x, y2 = c[2].y;
    const x3 = c[1].x, y3 = c[1].y, x4 = c[3].x, y4 = c[3].y;
    const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(den) > 1e-6) {
      const a = x1 * y2 - y1 * x2;
      const b = x3 * y4 - y3 * x4;
      return { x: (a * (x3 - x4) - (x1 - x2) * b) / den, y: (a * (y3 - y4) - (y1 - y2) * b) / den };
    }
    return {
      x: (c[0].x + c[1].x + c[2].x + c[3].x) / 4,
      y: (c[0].y + c[1].y + c[2].y + c[3].y) / 4,
    };
  }

  // Turn a detector result into {id, corners} (largest marker wins)
  function pickLargest(list) {
    let best = null, bestP = -1;
    for (const m of list) {
      if (!m || !m.corners || m.corners.length !== 4) continue;
      const p = perimeter(m.corners);
      if (p > bestP) { bestP = p; best = m; }
    }
    return best ? { id: best.id, corners: best.corners.map(p => ({ x: p.x, y: p.y })) } : null;
  }

  // Write a detection (or null) into the shared state
  function applyDetection(det, w, h, mode) {
    const now = Date.now();
    state.frameWidth = w;
    state.frameHeight = h;
    state.mode = mode;

    if (det) {
      const c = centerOf(det.corners);
      if (smoothedCorners.value && smoothedCorners.value.length === det.corners.length) {
        det = {
          id: det.id,
          corners: det.corners.map((p, i) => ({
            x: 0.72 * p.x + 0.28 * smoothedCorners.value[i].x,
            y: 0.72 * p.y + 0.28 * smoothedCorners.value[i].y,
          })),
        };
        smoothedCorners.value = det.corners;
      } else {
        smoothedCorners.value = det.corners.map(p => ({ x: p.x, y: p.y }));
      }
      const smoothedCenter = centerOf(det.corners);
      state.active = true;
      state.pixelX = smoothedCenter.x;
      state.pixelY = smoothedCenter.y;
      state.corners = det.corners;
      state.markerId = det.id;
      state.lostFrames = 0;
      lastSeenAt = now;
    } else if (state.active && now - lastSeenAt > LOST_GRACE_MS) {
      state.active = false;
      state.pixelX = null;
      state.pixelY = null;
      state.corners = null;
      state.markerId = null;
      smoothedCorners.value = null;
    }
    if (!det) state.lostFrames += 1;
  }

  // ---------- OpenCV server ----------
  function handleServerReply(data) {
    server.lastReply = Date.now();
    let list = [];
    if (data && Array.isArray(data.markers) && data.markers.length) {
      list = data.markers.map(m => ({ id: Number(m.markerId), corners: m.corners.map(p => ({ x: Number(p.x), y: Number(p.y) })) }));
    } else if (data && data.active && Array.isArray(data.corners) && data.corners.length === 4) {
      list = [{ id: Number(data.markerId), corners: data.corners.map(p => ({ x: Number(p.x), y: Number(p.y) })) }];
    }
    server.detection = pickLargest(list);
  }

  let sendBusy = false;
  function sendFrameToServer() {
    if (sendBusy) return;
    const source = CameraModule.getCurrentFrameSource();
    const { w, h } = sourceSize(source);
    if (!source || !w || !h) return;
    sendBusy = true;
    try {
      sendCanvas.width = w;
      sendCanvas.height = h;
      sendCtx.drawImage(source, 0, 0, w, h);
    } catch (e) { sendBusy = false; return; }
    sendCanvas.toBlob(blob => {
      if (!blob) { sendBusy = false; return; }
      fetch(SERVER_URL + "/frame", { method: "POST", body: blob, headers: { "Content-Type": "image/jpeg" } })
        .then(res => (res.ok ? res.json() : null))
        .then(data => { if (data) handleServerReply(data); })
        .catch(() => {})
        .finally(() => { sendBusy = false; });
    }, "image/jpeg", 0.8);
  }

  // ---------- Browser (js-aruco) fallback ----------
  function runJsDetector(source, w, h) {
    const scale = Math.min(1, JS_MAX_WIDTH / w);
    const sw = Math.max(1, Math.round(w * scale));
    const sh = Math.max(1, Math.round(h * scale));
    jsCanvas.width = sw;
    jsCanvas.height = sh;
    jsCtx.drawImage(source, 0, 0, sw, sh);
    const imageData = jsCtx.getImageData(0, 0, sw, sh);
    const inv = 1 / scale;
    const markers = detector.detect(imageData);
    return pickLargest(markers.map(m => ({
      id: m.id,
      corners: m.corners.map(p => ({ x: p.x * inv, y: p.y * inv })),
    })));
  }

  // ---------- public API ----------
  function detectOnce() {
    const now = Date.now();
    if (now - server.lastReply < SERVER_ALIVE_MS) {
      const source = CameraModule.getCurrentFrameSource();
      const size = sourceSize(source);
      applyDetection(server.detection, size.w || 1280, size.h || 720, "server");
      return state;
    }

    const source = CameraModule.getCurrentFrameSource();
    const { w, h } = sourceSize(source);
    if (!source || !w || !h) return state;

    if (now - lastJsAt >= JS_INTERVAL_MS) {
      lastJsAt = now;
      try { jsDetection = runJsDetector(source, w, h); } catch (e) { jsDetection = null; }
    }
    applyDetection(jsDetection, w, h, "browser");
    return state;
  }

  let started = false;
  function startServerPolling() {
    if (started) return;
    started = true;
    setInterval(sendFrameToServer, SEND_INTERVAL_MS);
    const pollMarkerServer = () => {
      fetch(SERVER_URL + "/marker", { mode: "cors", cache: "no-store" })
        .then(res => (res.ok ? res.json() : null))
        .then(data => { if (data) handleServerReply(data); })
        .catch(() => {});
    };
    pollMarkerServer();
    setInterval(pollMarkerServer, SEND_INTERVAL_MS);
    setInterval(() => {
      const info = document.getElementById("cameraInfo");
      if (!info) return;
      info.textContent = state.mode === "server" ? "Tracking: OpenCV server"
        : state.mode === "browser" ? "Tracking: browser (start aruco_tracker_server.py for better accuracy)"
        : "Using default camera";
    }, 1000);
  }

  return { detectOnce, state, startServerPolling };
})();

Tracking.startServerPolling();
