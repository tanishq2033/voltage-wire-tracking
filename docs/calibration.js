// =====================================================================
// CALIBRATION MODULE
// v1 approach: assumes the camera frame is aligned to fully capture the
// wall. Converts a pixel position into an approximate real-world (ft)
// position by simple proportional scaling:
//    realX = (pixelX / frameWidth)  * wallWidth
//    realY = (pixelY / frameHeight) * wallHeight
// This is intentionally simple for a first working prototype; a later
// version can replace this with a proper homography using 4
// user-clicked reference corners.
// =====================================================================

const Calibration = (() => {
  let wallWidth = 10;
  let wallHeight = 8;
  let camDistance = 3;
  // intrinsics
  let fx = null, fy = null, cx = null, cy = null;
  let wallCorners = null;

  function apply(w, h, d) {
    wallWidth = parseFloat(w) || wallWidth;
    wallHeight = parseFloat(h) || wallHeight;
    camDistance = parseFloat(d) || camDistance;
  }

  function pixelToReal(px, py, frameW, frameH) {
    if (!frameW || !frameH) return { x: null, y: null };

    if (wallCorners && wallCorners.length === 4) {
      const H = solveHomography(
        wallCorners.map(p => [p.x, p.y]),
        [[0, 0], [wallWidth, 0], [wallWidth, wallHeight], [0, wallHeight]]
      );
      if (H) {
        const den = H[6] * px + H[7] * py + H[8];
        if (Math.abs(den) > 1e-8) {
          const x = (H[0] * px + H[1] * py + H[2]) / den;
          const y = (H[3] * px + H[4] * py + H[5]) / den;
          return {
            x: Math.round(x * 10) / 10,
            y: Math.round(y * 10) / 10,
          };
        }
      }
    }

    const x = (px / frameW) * wallWidth;
    const y = (py / frameH) * wallHeight;
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
  }

  function solveHomography(src, dst) {
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const x = src[i][0], y = src[i][1];
      const u = dst[i][0], v = dst[i][1];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
      b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
      b.push(v);
    }
    const h = gaussianSolve(A, b);
    if (!h) return null;
    return [...h, 1];
  }

  function gaussianSolve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
      }
      if (Math.abs(M[pivot][col]) < 1e-10) return null;
      [M[col], M[pivot]] = [M[pivot], M[col]];
      const scale = M[col][col];
      for (let j = col; j <= n; j++) M[col][j] /= scale;
      for (let row = 0; row < n; row++) {
        if (row === col) continue;
        const factor = M[row][col];
        for (let j = col; j <= n; j++) M[row][j] -= factor * M[col][j];
      }
    }
    return M.map(row => row[n]);
  }

  function setWallCorners(corners) {
    wallCorners = Array.isArray(corners) && corners.length === 4 ? corners : null;
  }

  function getWallCorners() {
    return wallCorners;
  }

  function get() { return { wallWidth, wallHeight, camDistance }; }

  function setIntrinsics(k){
    if (!k) return;
    fx = k.fx || fx; fy = k.fy || fy; cx = k.cx || cx; cy = k.cy || cy;
  }

  function getIntrinsics(){
    return { fx, fy, cx, cy };
  }

  // Return a camera matrix for a given frame, using stored intrinsics when available.
  function getCameraMatrix(frameW, frameH){
    const useFx = fx || frameW || 800;
    const useFy = fy || frameH || useFx;
    const useCx = cx != null ? cx : (frameW || 800) / 2;
    const useCy = cy != null ? cy : (frameH || 600) / 2;
    return [ [useFx,0,useCx], [0,useFy,useCy], [0,0,1] ];
  }

  return { apply, pixelToReal, get, setIntrinsics, getIntrinsics, getCameraMatrix, setWallCorners, getWallCorners };
})();

// =====================================================================
// WIRE MARKING MODULE
// Lets the user click points on the overlay canvas to mark the visible
// wire path. Later this can be swapped for OpenCV-based auto detection
// without changing anything else in the app.
// =====================================================================

const WireMarking = (() => {
  let points = [];
  let markingMode = false;
  let highSegments = [];
  const PROXIMITY_PX = 30; // how close the device marker must be to "be near the wire"
  const HS_KEY = "vwt_high_wire_segments_v1";

  function toggleMarkingMode() {
    markingMode = !markingMode;
    return markingMode;
  }

  function isMarking() { return markingMode; }

  function addPoint(x, y) {
    if (markingMode) points.push({ x, y });
  }

  // ---- Automatic HIGH trail ------------------------------------------------
  // Every time the ESP32 reports HIGH while the marker is tracked, the marker
  // position is stored here. Consecutive points join into a stroke, which is
  // drawn as the red "live wire" line. Coordinates are normalised (0..1 of the
  // camera frame) so they survive resolution/size changes.
  const TRAIL_KEY = "vwt_high_trail_v1";
  const TRAIL_JOIN_DIST = 0.12;   // max jump (fraction of frame) to stay in the same stroke
  const TRAIL_JOIN_MS = 1500;     // max time gap to stay in the same stroke
  const TRAIL_MIN_STEP = 0.004;   // ignore points closer than this to the previous one
  const TRAIL_MAX_POINTS = 3000;
  let trail = [];                 // array of strokes; stroke = [{x, y, t}]

  function recordHighPoint(nx, ny) {
    const now = Date.now();
    let stroke = trail.length ? trail[trail.length - 1] : null;
    const last = stroke ? stroke[stroke.length - 1] : null;
    if (last) {
      const d = Math.hypot(nx - last.x, ny - last.y);
      if (d < TRAIL_MIN_STEP) { last.t = now; return; }
      if (d > TRAIL_JOIN_DIST || now - last.t > TRAIL_JOIN_MS) stroke = null;
    }
    if (!stroke) { stroke = []; trail.push(stroke); }
    stroke.push({ x: nx, y: ny, t: now });
    let total = 0;
    trail.forEach(s => { total += s.length; });
    while (total > TRAIL_MAX_POINTS && trail.length) {
      total -= trail[0].length;
      trail.shift();
    }
    saveTrail();
  }

  let lastTrailSave = 0;
  function saveTrail() {
    const now = Date.now();
    if (now - lastTrailSave < 1000) return;
    lastTrailSave = now;
    try { localStorage.setItem(TRAIL_KEY, JSON.stringify(trail)); } catch (e) {}
  }

  function loadTrail() {
    try {
      const saved = JSON.parse(localStorage.getItem(TRAIL_KEY) || "[]");
      if (Array.isArray(saved)) trail = saved.filter(Array.isArray);
    } catch (e) { trail = []; }
  }

  function getHighTrail() { return trail; }

  function clear() {
    points = [];
    highSegments = [];
    trail = [];
    try { localStorage.removeItem(HS_KEY); } catch (e) {}
    try { localStorage.removeItem(TRAIL_KEY); } catch (e) {}
  }

  function getPoints() { return points; }
  function getHighSegments() { return highSegments; }

  // Returns true if (x,y) pixel position is within PROXIMITY_PX of any
  // marked wire point.
  function isNear(x, y) {
    if (x == null || y == null || points.length < 2) return false;
    return findNearestSegment(x, y) != null;
  }

  function pointToSegmentDistance(px, py, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return Math.hypot(px - a.x, py - a.y);
    let t = ((px - a.x) * dx + (py - a.y) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
    const closestX = a.x + t * dx;
    const closestY = a.y + t * dy;
    return Math.hypot(px - closestX, py - closestY);
  }

  function findNearestSegment(x, y) {
    if (x == null || y == null || points.length < 2) return null;
    let nearest = null;
    let nearestDistance = PROXIMITY_PX;
    for (let i = 1; i < points.length; i++) {
      const distance = pointToSegmentDistance(x, y, points[i - 1], points[i]);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = { a: points[i - 1], b: points[i] };
      }
    }
    return nearest;
  }

  function recordHighSegment(x, y) {
    const segment = findNearestSegment(x, y);
    if (!segment) return null;
    const duplicate = highSegments.some(s =>
      s.a.x === segment.a.x && s.a.y === segment.a.y &&
      s.b.x === segment.b.x && s.b.y === segment.b.y
    );
    if (!duplicate) {
      highSegments.push(segment);
      try { localStorage.setItem(HS_KEY, JSON.stringify(highSegments)); } catch (e) {}
    }
    return segment;
  }

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(HS_KEY) || "[]");
      if (Array.isArray(saved)) highSegments = saved;
    } catch (e) {
      highSegments = [];
    }
  }

  load();
  loadTrail();

  return {
    recordHighPoint,
    getHighTrail,
    toggleMarkingMode,
    isMarking,
    addPoint,
    clear,
    getPoints,
    getHighSegments,
    isNear,
    findNearestSegment,
    recordHighSegment,
  };
})();