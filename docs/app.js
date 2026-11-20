// =====================================================================
// APP.JS
// Wires together ESP32Connection + CameraModule + Tracking + Calibration
// + WireMarking, runs the render loop, and updates all UI elements.
// =====================================================================

const ctx = () => CameraModule.overlay.getContext("2d");

// ---------- UI element refs ----------
const el = {
  esp32Ip: document.getElementById("esp32Ip"),
  btnConnectEsp32: document.getElementById("btnConnectEsp32"),
  btnStartCamera: document.getElementById("btnStartCamera"),
  btnStopCamera: document.getElementById("btnStopCamera"),
  btnRequestCameraPerm: document.getElementById("btnRequestCameraPerm"),
  chkManualMarking: document.getElementById("chkManualMarking"),
  btnSaveSnapshot: document.getElementById("btnSaveSnapshot"),
  imageUpload: document.getElementById("imageUpload"),
  wallWidth: document.getElementById("wallWidth"),
  wallHeight: document.getElementById("wallHeight"),
  camDistance: document.getElementById("camDistance"),
  markerSize: document.getElementById("markerSize"),
  btnApplyCalibration: document.getElementById("btnApplyCalibration"),
  btnAutoCalibrate: document.getElementById("btnAutoCalibrate"),
  btnMarkWireMode: document.getElementById("btnMarkWireMode"),
  btnClearWire: document.getElementById("btnClearWire"),
  btnCompleteWire: document.getElementById("btnCompleteWire"),

  voltageValue: document.getElementById("voltageValue"),
  voltageStatus: document.getElementById("voltageStatus"),

  statusEsp32: document.getElementById("statusEsp32"),
  statusCamera: document.getElementById("statusCamera"),
  statusTracking: document.getElementById("statusTracking"),

  dashEsp32State: document.getElementById("dashEsp32State"),
  dashVoltage: document.getElementById("dashVoltage"),
  dashStatus: document.getElementById("dashStatus"),
  dashTracking: document.getElementById("dashTracking"),
  dashX: document.getElementById("dashX"),
  dashY: document.getElementById("dashY"),
  dashWallWidth: document.getElementById("dashWallWidth"),
  dashWallHeight: document.getElementById("dashWallHeight"),
  dashCamDist: document.getElementById("dashCamDist"),
};

// ---------- ESP32 connect button ----------
const DEFAULT_ESP32_IP = "192.168.1.35";
let savedEsp32Ip = localStorage.getItem('esp32Ip');
if (savedEsp32Ip === "192.168.1.40") {
  savedEsp32Ip = DEFAULT_ESP32_IP;
  localStorage.setItem('esp32Ip', savedEsp32Ip);
}
if (el.esp32Ip && savedEsp32Ip) {
  el.esp32Ip.value = savedEsp32Ip;
} else if (el.esp32Ip) {
  el.esp32Ip.value = DEFAULT_ESP32_IP;
}

if (el.btnConnectEsp32) {
  el.btnConnectEsp32.addEventListener("click", () => {
    const ip = el.esp32Ip && el.esp32Ip.value ? el.esp32Ip.value.trim() : '';
    const statusEl = document.getElementById('cameraError');
    if (!ip) {
      statusEl && (statusEl.textContent = 'Enter ESP32 IP address before connecting');
      return;
    }
    try {
      localStorage.setItem('esp32Ip', ip);
      ESP32.connect(ip);
      statusEl && (statusEl.textContent = 'Connecting to ESP32...');
    } catch (e) {
      statusEl && (statusEl.textContent = 'Connection failed: ' + (e.message || e));
    }
  });
}

if ((savedEsp32Ip || DEFAULT_ESP32_IP) && el.esp32Ip) {
  try {
    ESP32.connect(savedEsp32Ip || DEFAULT_ESP32_IP);
  } catch (e) {
    console.warn('Auto-connect failed', e);
  }
}

ESP32.onUpdate((state) => {
  const voltageMv = state.voltage != null ? (state.voltage * 1000) : null;

  el.voltageValue.textContent = voltageMv != null ? voltageMv.toFixed(1) : "--";
  el.voltageStatus.textContent = state.status || "--";
  el.voltageStatus.style.color = state.status === "HIGH" ? "#ff4d5e" : "#33d17a";

  const errEl = document.getElementById('cameraError');
  if (errEl) {
    errEl.textContent = state.connected ? 'ESP32 connected' : 'Connecting to ESP32...';
  }

  setBadge(el.statusEsp32, state.connected, "ESP32");
  el.dashEsp32State.textContent = "CONNECTED: " + (state.connected ? "YES" : "NO");
  el.dashVoltage.textContent = "Voltage: " + (voltageMv != null ? voltageMv.toFixed(1) : "--") + " mV";
  el.dashStatus.textContent = "Status: " + (state.status || "--");

  const mainDisplay = document.querySelector('.readout');
  if (mainDisplay) {
    const label = mainDisplay.querySelector('.label');
    if (label) {
      label.textContent = 'Voltage:';
    }
    mainDisplay.innerHTML = `<div><span class="label">Voltage:</span> <span id="voltageValue">${voltageMv != null ? voltageMv.toFixed(1) : "--"}</span> mV</div><div><span class="label">Status:</span> <span id="voltageStatus">${state.status || "--"}</span></div>`;
    const valueEl = document.getElementById('voltageValue');
    const statusEl = document.getElementById('voltageStatus');
    if (statusEl) statusEl.style.color = state.status === "HIGH" ? "#ff4d5e" : "#33d17a";
  }
});

// ---------- Camera controls ----------
if (el.btnStartCamera) {
  el.btnStartCamera.addEventListener("click", async () => {
    const errEl = document.getElementById('cameraError');
    try{
      const ok = await CameraModule.start();
      setBadge(el.statusCamera, ok, "Camera", "ACTIVE", "INACTIVE");
      if (!ok) {
        const lastErr = CameraModule.getLastError && CameraModule.getLastError();
        if (lastErr) {
          errEl && (errEl.textContent = `${lastErr.name}: ${lastErr.message}`);
          console.error(lastErr);
        } else {
          errEl && (errEl.textContent = 'Failed to start camera — check permissions or device in use.');
        }
      } else { if (errEl) errEl.textContent = ''; }
    }catch(e){ console.error('start failed', e); errEl && (errEl.textContent = e.message || 'start failed'); setBadge(el.statusCamera, false, "Camera", "ACTIVE", "INACTIVE"); }
  });
}

if (el.btnRequestCameraPerm) {
  el.btnRequestCameraPerm.addEventListener('click', async () => {
    const ok = await CameraModule.requestPermission && CameraModule.requestPermission();
    const errEl = document.getElementById('cameraError');
    if (ok) {
      errEl && (errEl.textContent = 'Permission granted — try Start Camera');
      // refresh device list for debug
      populateCameraDevices();
    } else {
      errEl && (errEl.textContent = 'Permission denied or blocked — check browser site settings');
    }
  });
}

if (el.btnStopCamera) {
  el.btnStopCamera.addEventListener('click', () => {
    try { CameraModule.stop(); setBadge(el.statusCamera, false, 'Camera', 'ACTIVE', 'INACTIVE'); } catch (e) {}
  });
}

// Populate camera device selector
async function populateCameraDevices(){
  const sel = document.getElementById('cameraSelect');
  const errEl = document.getElementById('cameraError');
  try{
    // deprecated when camera selection UI removed — keep for debug outputs
    const devices = await navigator.mediaDevices.enumerateDevices();
    const dbg = document.getElementById('cameraDebug');
    if (dbg) dbg.dataset.fullDeviceList = JSON.stringify(devices.map(d=>({kind:d.kind,label:d.label,deviceId:d.deviceId})), null, 2);
    const cams = devices.filter(d=>d.kind==='videoinput');
    if (cams.length===0) errEl.textContent = 'No camera devices found'; else errEl.textContent = '';
  }catch(e){ if (errEl) errEl.textContent = 'Permissions required or no devices'; }
}
// Ensure permission prompt is requested on first load so enumerateDevices returns labels
async function ensureDevices(){
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try{
    await populateCameraDevices();
    const sel = document.getElementById('cameraSelect');
    if (sel.options.length===0) {
      // try requesting permission to reveal devices
      await CameraModule.requestPermission && CameraModule.requestPermission();
      await populateCameraDevices();
    }
  }catch(e){}
}
ensureDevices();
navigator.mediaDevices && navigator.mediaDevices.addEventListener && navigator.mediaDevices.addEventListener('devicechange', populateCameraDevices);

// Debug: show camera module errors and devices
function updateCameraDebug(){
  const dbg = document.getElementById('cameraDebug');
  if (!dbg) return;
  const lastErr = CameraModule.getLastError && CameraModule.getLastError();
  const sel = document.getElementById('cameraSelect');
  let html = '';
  html += '<div><strong>Available devices:</strong></div>';
  if (sel && sel.options) {
    for (let i=0;i<sel.options.length;i++){ html += `<div>${i+1}. ${sel.options[i].text}</div>`; }
  } else {
    // camera selector removed — show device list from dataset if available
    if (dbg.dataset && dbg.dataset.fullDeviceList) {
      try{
        const list = JSON.parse(dbg.dataset.fullDeviceList);
        const cams = list.filter(d=>d.kind==='videoinput');
        if (cams.length===0) html += '<div>None</div>';
        else cams.forEach((c,i)=> html += `<div>${i+1}. ${c.label || 'Camera '+(i+1)}</div>`);
      }catch(e){ html += '<div>Device list unavailable</div>'; }
    } else {
      html += '<div>Device selector removed — use Request Permission then Start Camera</div>';
    }
  }
  html += '<hr/>';
  html += '<div><strong>Last camera error:</strong></div>';
  if (lastErr) {
    html += `<div>${lastErr.name}: ${lastErr.message}</div>`;
    html += `<pre style="white-space:pre-wrap; font-size:0.75rem; color:var(--muted);">${lastErr.stack || ''}</pre>`;
  } else {
    html += `<div>None</div>`;
  }
  // include full enumerateDevices dump if available
  if (dbg.dataset && dbg.dataset.fullDeviceList) {
    html += '<hr/>';
    html += '<div><strong>enumerateDevices output:</strong></div>';
    try{
      const parsed = JSON.parse(dbg.dataset.fullDeviceList);
      html += `<pre style="white-space:pre-wrap; font-size:0.75rem; color:var(--muted);">${JSON.stringify(parsed, null, 2)}</pre>`;
    }catch(e){ html += '<div>Could not parse device list</div>'; }
  }

  // permission state
  if (navigator.permissions && navigator.permissions.query) {
    try{
      navigator.permissions.query({ name: 'camera' }).then(p => {
        html += '<hr/>';
        html += `<div><strong>Camera permission state:</strong> ${p.state}</div>`;
        // video srcObject + tracks
        try{
          const v = CameraModule && CameraModule.video;
          const src = v && v.srcObject;
          html += '<hr/>';
          html += `<div><strong>Video srcObject present:</strong> ${src ? 'yes' : 'no'}</div>`;
          if (src && src.getTracks) {
            const tracks = src.getTracks().map(t=>({kind:t.kind,enabled:t.enabled,readyState:t.readyState,label:t.label}));
            html += `<div><strong>Tracks:</strong></div><pre style="white-space:pre-wrap; font-size:0.75rem; color:var(--muted);">${JSON.stringify(tracks,null,2)}</pre>`;
          }
        }catch(e){}
        dbg.innerHTML = html;
      }).catch(()=>{ dbg.innerHTML = html; });
      return;
    }catch(e){}
  }

  // fallback show video srcObject if permission API not available
  try{
    const v = CameraModule && CameraModule.video;
    const src = v && v.srcObject;
    html += '<hr/>';
    html += `<div><strong>Video srcObject present:</strong> ${src ? 'yes' : 'no'}</div>`;
    if (src && src.getTracks) {
      const tracks = src.getTracks().map(t=>({kind:t.kind,enabled:t.enabled,readyState:t.readyState,label:t.label}));
      html += `<div><strong>Tracks:</strong></div><pre style="white-space:pre-wrap; font-size:0.75rem; color:var(--muted);">${JSON.stringify(tracks,null,2)}</pre>`;
    }
  }catch(e){}

  dbg.innerHTML = html;
}
setInterval(updateCameraDebug, 1500);

function saveAnnotatedSnapshot(completionLabel) {
  try {
    const source = CameraModule.getCurrentFrameSource();
    if (!source) { alert('No frame available'); return; }
    const w = CameraModule.overlay.width;
    const h = CameraModule.overlay.height;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const octx = out.getContext('2d');
    octx.drawImage(source, 0, 0, w, h);
    octx.drawImage(CameraModule.overlay, 0, 0, w, h);

    if (completionLabel) {
      octx.fillStyle = "rgba(10, 16, 32, 0.85)";
      octx.fillRect(12, h - 48, 310, 36);
      octx.fillStyle = "#ffffff";
      octx.font = "bold 16px sans-serif";
      octx.fillText(completionLabel, 24, h - 24);
    }

    out.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      a.download = `voltage-wire-map-${ts}.png`;
      a.href = url;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, 'image/png');
  } catch (e) {
    console.error('Snapshot failed', e);
    alert('Snapshot failed: ' + e.message);
  }
}

if (el.btnSaveSnapshot) {
  el.btnSaveSnapshot.addEventListener("click", () => saveAnnotatedSnapshot("Voltage wire snapshot"));
}

if (el.imageUpload) {
  el.imageUpload.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
      CameraModule.loadTestImage(file);
      setBadge(el.statusCamera, true, "Camera", "ACTIVE", "INACTIVE");
    }
  });
}

// ---------- Calibration ----------
if (el.btnApplyCalibration) {
  el.btnApplyCalibration.addEventListener("click", () => {
    Calibration.apply(el.wallWidth.value, el.wallHeight.value, el.camDistance.value);
    const c = Calibration.get();
    el.dashWallWidth.textContent = "Width: " + c.wallWidth + " ft";
    el.dashWallHeight.textContent = "Height: " + c.wallHeight + " ft";
    el.dashCamDist.textContent = "Camera Distance: " + c.camDistance + " ft";
  });
}
// apply defaults immediately
if (el.btnApplyCalibration) {
  el.btnApplyCalibration.click();
}

if (!el.btnWallCorners) el.btnWallCorners = document.getElementById("btnWallCorners");
if (el.btnWallCorners) {
  let wallCornerPixels = [];
  el.btnWallCorners.addEventListener("click", () => {
    wallCornerPixels = [];
    el.btnWallCorners.textContent = "⌗ Click Top-Left";
    el.btnWallCorners.classList.add("active");
    if (CameraModule.overlay) CameraModule.overlay.style.pointerEvents = "auto";
    const errEl = document.getElementById("cameraError");
    if (errEl) errEl.textContent = "Wall calibration: click Top-Left, Top-Right, Bottom-Right, then Bottom-Left";
  });

  if (CameraModule.overlay) {
    CameraModule.overlay.addEventListener("click", (evt) => {
      if (!wallCornerPixels || wallCornerPixels.length >= 4 || !el.btnWallCorners.classList.contains("active")) return;
      const rect = CameraModule.overlay.getBoundingClientRect();
      const scaleX = CameraModule.overlay.width / rect.width;
      const scaleY = CameraModule.overlay.height / rect.height;
      wallCornerPixels.push({
        x: (evt.clientX - rect.left) * scaleX,
        y: (evt.clientY - rect.top) * scaleY,
      });
      const labels = ["Top-Right", "Bottom-Right", "Bottom-Left", "Done"];
      el.btnWallCorners.textContent = wallCornerPixels.length < 4
        ? "⌗ Click " + labels[wallCornerPixels.length]
        : "✓ Wall Corners Set";
      if (wallCornerPixels.length === 4) {
        Calibration.setWallCorners(wallCornerPixels);
        el.btnWallCorners.classList.remove("active");
        if (CameraModule.overlay) CameraModule.overlay.style.pointerEvents = "none";
        const errEl = document.getElementById("cameraError");
        if (errEl) errEl.textContent = "Wall homography calibration applied";
      }
    });
  }
}

if (el.btnAutoCalibrate) {
  el.btnAutoCalibrate.addEventListener("click", () => {
    // estimate focal length from observed ArUco marker pixel size
    const t = Tracking.detectOnce();
    if (!t.active || t.markerId == null) {
      const msg = 'No ArUco marker detected. Print the generated marker, keep it flat and fully visible in the camera frame, and try again.';
      const errEl = document.getElementById('cameraError');
      if (errEl) errEl.textContent = msg;
      alert(msg);
      return;
    }
    // find marker corners from detector by re-running on current frame
    const source = CameraModule.getCurrentFrameSource();
    if (!source) { alert('No camera frame'); return; }
    // draw on working canvas in Tracking module via its detector state -- simpler: approximate marker pixel size as frame fraction
    const frameW = t.frameWidth, frameH = t.frameHeight;
    // assume marker occupies ~0.1 of frame width if not exact
    let markerPx = Math.max(20, frameW * 0.12);
    if (t.corners && t.corners.length === 4) {
      const c = t.corners;
      const side = (i, j) => Math.hypot(c[i].x - c[j].x, c[i].y - c[j].y);
      markerPx = (side(0,1) + side(1,2) + side(2,3) + side(3,0)) / 4;
    }
    // read physical marker size in inches, convert to same units as camDistance (feet) -> convert inches to feet
    const sizeInches = parseFloat(el.markerSize.value) || 2;
    const sizeFeet = sizeInches / 12.0;
    const distFeet = Calibration.get().camDistance || 3;
    // focal length estimate: fx = (marker_px * distance) / marker_real_width
    const fx = (markerPx * distFeet) / sizeFeet;
    Calibration.setIntrinsics({ fx: fx, fy: fx, cx: frameW/2, cy: frameH/2 });
    alert('Auto calibration applied (approx).');
  });
}

// ---------- Wire marking ----------
if (el.btnMarkWireMode) {
  el.btnMarkWireMode.addEventListener("click", () => {
    const on = WireMarking.toggleMarkingMode();
    el.btnMarkWireMode.classList.toggle("active", on);
    el.btnMarkWireMode.textContent = on ? "Stop Marking" : "Mark Wire Path";
    if (CameraModule.overlay) {
      CameraModule.overlay.style.pointerEvents = on ? "auto" : "none";
    }
  });
}
if (el.btnClearWire) {
  el.btnClearWire.addEventListener("click", () => {
    WireMarking.clear();
    if (CameraModule.overlay) {
      CameraModule.overlay.style.pointerEvents = "none";
    }
    if (el.btnMarkWireMode) {
      el.btnMarkWireMode.textContent = "Mark Wire Path";
      el.btnMarkWireMode.classList.remove("active");
    }
  });
}

if (el.btnCompleteWire) {
  el.btnCompleteWire.addEventListener("click", () => {
    if (WireMarking.isMarking()) WireMarking.toggleMarkingMode();
    el.btnMarkWireMode && el.btnMarkWireMode.classList.remove("active");
    if (el.btnMarkWireMode) el.btnMarkWireMode.textContent = "Mark Wire Path";
    if (CameraModule.overlay) CameraModule.overlay.style.pointerEvents = "none";
    saveAnnotatedSnapshot("Wire map completed - HIGH segments marked");
  });
}

if (CameraModule.overlay) {
  CameraModule.overlay.addEventListener("click", (evt) => {
    if (!WireMarking.isMarking()) return;
    // respect manual marking toggle
    if (el.chkManualMarking && !el.chkManualMarking.checked) return;
    const pt = clientToFrame(evt);
    WireMarking.addPoint(pt.x, pt.y);
  });
}

// ---------- Badge helper ----------
function setBadge(elm, isOn, label, onText = "CONNECTED", offText = "DISCONNECTED") {
  if (!elm) return;
  const txt = isOn ? onText : offText;
  // update inner label-text if present
  const lab = elm.querySelector ? elm.querySelector('.label-text') : null;
  if (lab) lab.textContent = `${label}: ${txt}`;
  else elm.textContent = `${label}: ${txt}`;
  elm.classList.toggle("badge-on", isOn);
  elm.classList.toggle("badge-off", !isOn);
}

// ---------- Helpers for drawing / mapping ----------
// Map a mouse click on the overlay to camera-frame pixel coordinates.
// Accounts for the letterboxing caused by object-fit: contain.
function clientToFrame(evt) {
  const o = CameraModule.overlay;
  const rect = o.getBoundingClientRect();
  const scale = Math.min(rect.width / o.width, rect.height / o.height);
  const offX = (rect.width - o.width * scale) / 2;
  const offY = (rect.height - o.height * scale) / 2;
  return {
    x: (evt.clientX - rect.left - offX) / scale,
    y: (evt.clientY - rect.top - offY) / scale,
  };
}

// Red line along every place where the ESP32 reported HIGH voltage
function drawHighTrail(c, W, H, s) {
  const trail = WireMarking.getHighTrail();
  if (!trail.length) return;
  c.save();
  c.lineCap = "round";
  c.lineJoin = "round";
  trail.forEach(stroke => {
    if (!stroke.length) return;
    if (stroke.length === 1) {
      c.fillStyle = "#ff3b4e";
      c.beginPath();
      c.arc(stroke[0].x * W, stroke[0].y * H, 6 * s, 0, Math.PI * 2);
      c.fill();
      return;
    }
    c.beginPath();
    stroke.forEach((p, i) => (i === 0 ? c.moveTo(p.x * W, p.y * H) : c.lineTo(p.x * W, p.y * H)));
    // soft glow, then the solid line on top
    c.strokeStyle = "rgba(255, 59, 78, 0.30)";
    c.lineWidth = 18 * s;
    c.stroke();
    c.strokeStyle = "#ff3b4e";
    c.lineWidth = 8 * s;
    c.stroke();
  });
  c.restore();
}

// Box around the tracked ArUco marker (outline of the real marker + padded bounding box)
function drawMarkerBox(c, t, isHigh, s) {
  c.save();

  const color = isHigh ? "#ff3b4e" : "#f05a00";
  const radius = Math.max(10, 16 * s);

  c.beginPath();
  c.arc(t.pixelX, t.pixelY, radius, 0, Math.PI * 2);
  c.fillStyle = color;
  c.fill();
  c.strokeStyle = "#ffffff";
  c.lineWidth = 3 * s;
  c.stroke();

  if (isHigh && WireMarking.isNear(t.pixelX, t.pixelY)) {
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 180);
    c.beginPath();
    c.arc(t.pixelX, t.pixelY, radius + 14 * s + pulse * 8 * s, 0, Math.PI * 2);
    c.strokeStyle = "rgba(255, 45, 61, 0.75)";
    c.lineWidth = 5 * s;
    c.stroke();
  }

  const label = `ArUco #${t.markerId != null ? t.markerId : "?"} ${isHigh ? "HIGH" : (ESP32.state.status || "--")}`;
  c.font = `bold ${Math.round(15 * s)}px sans-serif`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  const tw = c.measureText(label).width;
  const bh = 26 * s;
  const bw = tw + 18 * s;
  let bx = t.pixelX - bw / 2;
  let by = t.pixelY - radius - bh - 8 * s;
  bx = Math.max(2, Math.min(bx, c.canvas.width - bw - 2));
  if (by < 2) by = t.pixelY + radius + 8 * s;
  by = Math.min(by, c.canvas.height - bh - 2);

  c.fillStyle = color;
  c.fillRect(bx, by, bw, bh);
  c.fillStyle = "#ffffff";
  c.fillText(label, bx + bw / 2, by + bh / 2);

  c.restore();
}

// ---------- Main render loop: tracking + drawing + dashboard combine ----------
function renderLoop() {
  requestAnimationFrame(renderLoop);

  // Keep the overlay bitmap exactly the size of the camera frame so that
  // frame pixel (x, y) == overlay pixel (x, y).
  CameraModule.sizeOverlay();

  let t = { active: false, corners: null, pixelX: null, pixelY: null, frameWidth: 0, frameHeight: 0, markerId: null };
  try {
    t = Tracking.detectOnce();
  } catch (error) {
    console.error('Tracking error:', error);
    const errEl = document.getElementById('cameraError');
    if (errEl) errEl.textContent = 'Tracking error: ' + (error && error.message ? error.message : String(error));
    setBadge(el.statusTracking, false, "Tracking", "ACTIVE", "LOST");
    if (el.dashTracking) el.dashTracking.textContent = 'Tracking: LOST';
    if (CameraModule.overlay && CameraModule.overlay.getContext) {
      const c = CameraModule.overlay.getContext('2d');
      c.clearRect(0, 0, CameraModule.overlay.width, CameraModule.overlay.height);
    }
    return;
  }

  const trackingActive = !!t.active;
  setBadge(el.statusTracking, trackingActive, "Tracking", "ACTIVE", "LOST");
  if (el.dashTracking) el.dashTracking.textContent = "Tracking: " + (trackingActive ? "ACTIVE" : "LOST");

  const c = ctx();
  const W = CameraModule.overlay.width;
  const H = CameraModule.overlay.height;
  const s = Math.max(0.6, W / 1280);             // scale drawing sizes with resolution
  c.clearRect(0, 0, W, H);

  // Manually marked wire path (yellow)
  const wirePoints = WireMarking.getPoints();
  if (wirePoints.length > 0) {
    c.strokeStyle = "#ffd23f";
    c.lineWidth = 3 * s;
    c.beginPath();
    wirePoints.forEach((p, i) => (i === 0 ? c.moveTo(p.x, p.y) : c.lineTo(p.x, p.y)));
    c.stroke();
    wirePoints.forEach(p => {
      c.fillStyle = "#ffd23f";
      c.beginPath();
      c.arc(p.x, p.y, 4 * s, 0, Math.PI * 2);
      c.fill();
    });
  }

  // Manual wire segments that were already found HIGH (red)
  WireMarking.getHighSegments().forEach(segment => {
    c.strokeStyle = "#ff3b4e";
    c.lineWidth = 7 * s;
    c.beginPath();
    c.moveTo(segment.a.x, segment.a.y);
    c.lineTo(segment.b.x, segment.b.y);
    c.stroke();
  });

  const isHigh = !!(
    ESP32.state.connected &&
    typeof ESP32.state.voltage === "number" &&
    ESP32.state.voltage >= 0.025
  );

  if (t.active && t.pixelX != null) {
    // Mark automatically only at an ESP32 HIGH location that is on the possible wire path.
    const nearPossibleWire = WireMarking.isNear(t.pixelX, t.pixelY);
    if (isHigh && nearPossibleWire) {
      WireMarking.recordHighPoint(t.pixelX / (t.frameWidth || W), t.pixelY / (t.frameHeight || H));
      WireMarking.recordHighSegment(t.pixelX, t.pixelY);
    }

    drawHighTrail(c, W, H, s);
    drawMarkerBox(c, t, isHigh, s);

    const real = Calibration.pixelToReal(t.pixelX, t.pixelY, t.frameWidth, t.frameHeight);
    el.dashX.textContent = "X: " + (real.x != null ? real.x : "--") + " ft";
    el.dashY.textContent = "Y: " + (real.y != null ? real.y : "--") + " ft";
  } else {
    drawHighTrail(c, W, H, s);
    el.dashX.textContent = "X: -- ft";
    el.dashY.textContent = "Y: -- ft";
  }
}

renderLoop();

setInterval(() => {
  if (Tracking.state && Tracking.state.active) {
    setBadge(el.statusTracking, true, "Tracking", "ACTIVE", "LOST");
    if (el.dashTracking) el.dashTracking.textContent = "Tracking: ACTIVE";

    const real = Calibration.pixelToReal(
      Tracking.state.pixelX,
      Tracking.state.pixelY,
      Tracking.state.frameWidth,
      Tracking.state.frameHeight
    );
    if (el.dashX) el.dashX.textContent = "X: " + (real.x != null ? real.x : "--") + " ft";
    if (el.dashY) el.dashY.textContent = "Y: " + (real.y != null ? real.y : "--") + " ft";
    const markerId = document.getElementById("statMarkerId");
    const markerState = document.getElementById("statTrackingState");
    if (markerId) markerId.textContent = "ID " + String(Tracking.state.markerId).padStart(2, "0");
    if (markerState) markerState.textContent = "tracking active";
  } else if (typeof Tracking !== "undefined") {
    setBadge(el.statusTracking, false, "Tracking", "ACTIVE", "LOST");
    if (el.dashTracking) el.dashTracking.textContent = "Tracking: LOST";
    const markerId = document.getElementById("statMarkerId");
    const markerState = document.getElementById("statTrackingState");
    if (markerId) markerId.textContent = "--";
    if (markerState) markerState.textContent = "not detected";
  }
}, 250);

setInterval(() => {
  fetch("http://localhost:8765/marker", { cache: "no-store" })
    .then(response => response.ok ? response.json() : null)
    .then(data => {
      if (!data) return;

      const corners = Array.isArray(data.corners) ? data.corners : [];
      const active = !!data.active && corners.length === 4;
      Tracking.state.active = active;
      Tracking.state.pixelX = active ? Number(data.pixelX) : null;
      Tracking.state.pixelY = active ? Number(data.pixelY) : null;
      Tracking.state.corners = active ? corners : null;
      Tracking.state.markerId = active ? Number(data.markerId) : null;
      Tracking.state.frameWidth = Number(data.frameWidth || 1280);
      Tracking.state.frameHeight = Number(data.frameHeight || 720);
      Tracking.state.mode = active ? "server" : "none";
    })
    .catch(() => {});
}, 100);