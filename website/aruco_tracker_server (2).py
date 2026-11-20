import json
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np

PORT = 8765
CAMERA_INDEX = 0
# False = browser POSTs frames to /frame (no camera conflict, recommended)
# True  = server opens the camera itself (browser must NOT use the same camera)
USE_SERVER_CAMERA = False
OUTPUT_FILE = Path(__file__).resolve().parent / "website" / "aruco_marker_5x5_00.png"
MARKER_SIZE_PX = 1000

# The server tries every dictionary in this list, in order, and uses the first one
# that finds a marker. DICT_5X5_1000 also covers markers made with DICT_5X5_50/100/250
# (same codes for the same ids, e.g. aruco_marker_5x5_00.png = id 0).
DICTIONARY_NAMES = ["DICT_5X5_1000"]   # add "DICT_4X4_1000", "DICT_6X6_1000"... if you use them (each costs time per frame)
DETECTOR_PARAMETERS = cv2.aruco.DetectorParameters()
DETECTOR_PARAMETERS.adaptiveThreshWinSizeMin = 3
DETECTOR_PARAMETERS.adaptiveThreshWinSizeMax = 43
DETECTOR_PARAMETERS.adaptiveThreshWinSizeStep = 10
DETECTOR_PARAMETERS.minMarkerPerimeterRate = 0.01
DETECTOR_PARAMETERS.maxMarkerPerimeterRate = 4.0
DETECTOR_PARAMETERS.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
DETECTORS = []
for _name in DICTIONARY_NAMES:
    if hasattr(cv2.aruco, _name):
        _dict = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, _name))
        DETECTORS.append((_name, cv2.aruco.ArucoDetector(_dict, DETECTOR_PARAMETERS)))
# dictionary used to generate the printable marker file
DICTIONARY = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_5X5_1000)
MARKER_ID = 0
# Ids searched for by the black-board fallback (marker printed with no white margin).
BLACK_BOARD_IDS = [0]

EMPTY = {"active": False, "pixelX": None, "pixelY": None, "corners": [],
         "markerId": None, "frameWidth": 0, "frameHeight": 0, "markers": [],
         "method": None, "ms": 0.0}
marker_state = dict(EMPTY)
state_lock = threading.Lock()


def ensure_marker_file():
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    should_regenerate = True
    if OUTPUT_FILE.exists():
        try:
            img = cv2.imread(str(OUTPUT_FILE), cv2.IMREAD_GRAYSCALE)
            should_regenerate = img is None or img.size < 10000 or img.shape[0] < 1100
        except Exception:
            should_regenerate = True

    if should_regenerate:
        img = cv2.aruco.generateImageMarker(DICTIONARY, MARKER_ID, MARKER_SIZE_PX)
        img = cv2.copyMakeBorder(img, 100, 100, 100, 100, cv2.BORDER_CONSTANT, value=255)
        if not cv2.imwrite(str(OUTPUT_FILE), img):
            raise RuntimeError(f"Could not generate ArUco marker at {OUTPUT_FILE}")
        print(f"[marker] generated valid ArUco marker template at {OUTPUT_FILE}")
    else:
        print(f"[marker] using existing marker template at {OUTPUT_FILE}")



# ---------------------------------------------------------------------------
# Black-board mode: finds the marker from its white cells, so it still works when
# the black border merges into a black board (no white margin for the normal
# detector to trace). Pose is refined by aligning the marker image to the frame
# (ECC), which gives sub-pixel corners, and is tracked from the previous frame.
# ---------------------------------------------------------------------------
K = 12                      # template pixels per cell
CANVAS = 7 * K              # the marker only: what lies around it (black board or white paper) is ignored
# pixel-centre convention: the marker's outer edge lies half a pixel before cell 0
MARKER_SRC = np.float32([[-.5, -.5], [CANVAS - .5, -.5], [CANVAS - .5, CANVAS - .5], [-.5, CANVAS - .5]])
_templates = {}


def get_template(marker_id):
    if marker_id not in _templates:
        img = cv2.aruco.generateImageMarker(DICTIONARY, marker_id, 7 * K)
        canvas = img
        bits = (img[K // 2::K, K // 2::K] > 127)            # 7x7 cells
        ys, xs = np.nonzero(canvas > 127)
        pts = np.stack([xs, ys], 1).astype(np.float32)
        box = cv2.boxPoints(cv2.minAreaRect(cv2.convexHull(pts)))
        _templates[marker_id] = (canvas, bits, box.astype(np.float32))
    return _templates[marker_id]


def _side(c):
    c = np.asarray(c, np.float32)
    return float(np.mean([np.linalg.norm(c[i] - c[(i + 1) % 4]) for i in range(4)]))


def _bbox(pts, margin, w, h):
    x0 = int(max(0, np.floor(pts[:, 0].min() - margin)))
    y0 = int(max(0, np.floor(pts[:, 1].min() - margin)))
    x1 = int(min(w, np.ceil(pts[:, 0].max() + margin)))
    y1 = int(min(h, np.ceil(pts[:, 1].max() + margin)))
    return x0, y0, x1, y1


def corners_of(H):
    return cv2.perspectiveTransform(MARKER_SRC.reshape(1, 4, 2), H.astype(np.float64))[0]


def H_from_corners(c):
    return cv2.getPerspectiveTransform(MARKER_SRC, np.asarray(c, np.float32)).astype(np.float64)


def refine(gray, H, canvas, extra_blur=0.0, max_iter=60):
    """Align the marker image to the frame starting from H (canvas -> frame)."""
    h, w = gray.shape
    c = corners_of(H)
    side = _side(c)
    cell = side / 7.0
    if not (12 < side < 3 * max(h, w)):
        return None
    sc = min(1.0, 220.0 / side)
    x0, y0, x1, y1 = _bbox(cv2.perspectiveTransform(
        np.float32([[[0, 0], [CANVAS, 0], [CANVAS, CANVAS], [0, CANVAS]]]), H)[0],
        4 + 0.3 * cell + 2 * extra_blur, w, h)
    if x1 - x0 < 12 or y1 - y0 < 12:
        return None
    crop = gray[y0:y1, x0:x1].astype(np.float32) / 255.0
    if sc < 1.0:
        crop = cv2.resize(crop, None, fx=sc, fy=sc, interpolation=cv2.INTER_AREA)
    sig_img = float(np.hypot(0.9, extra_blur)) * sc
    crop = cv2.GaussianBlur(crop, (0, 0), sig_img)
    tpl_scale = cell * sc / K                                  # image px per template px
    tpl = cv2.GaussianBlur(canvas.astype(np.float32) / 255.0, (0, 0),
                           max(0.5, 1.0 * sig_img / max(tpl_scale, 1e-3)))
    T = np.array([[1, 0, -x0], [0, 1, -y0], [0, 0, 1]], np.float64)
    S = np.diag([sc, sc, 1.0])
    Hc = (S @ T @ H).astype(np.float32)
    Hc /= Hc[2, 2]
    try:
        crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, max_iter, 1e-6)
        cc, Hc2 = cv2.findTransformECC(tpl, crop, Hc, cv2.MOTION_HOMOGRAPHY, crit, None, 1)
    except cv2.error:
        return None
    Hn = np.linalg.inv(T) @ np.linalg.inv(S) @ Hc2.astype(np.float64)
    return Hn / Hn[2, 2], float(cc)


def verify(gray, H, bits):
    """Read the 7x7 cells through H and compare with the expected marker. -> mismatches or None"""
    c = corners_of(H)
    if not cv2.isContourConvex(c.astype(np.float32).reshape(-1, 1, 2)):
        return None
    side = _side(c)
    if side < 14:
        return None
    M = cv2.getPerspectiveTransform(c.astype(np.float32),
                                    np.float32([[0, 0], [70, 0], [70, 70], [0, 70]]))
    warp = cv2.warpPerspective(cv2.GaussianBlur(gray, (0, 0), 0.7), M, (70, 70),
                               flags=cv2.INTER_AREA)
    cells = warp.reshape(7, 10, 7, 10).transpose(0, 2, 1, 3)[:, :, 2:8, 2:8].mean(axis=(2, 3))
    white = cells[bits]
    black = cells[~bits]
    if white.size == 0 or black.size == 0:
        return None
    wm, bm = float(np.median(white)), float(np.median(black))
    if wm - bm < 40:
        return None
    thr = 0.5 * (wm + bm)
    return int(np.count_nonzero((cells > thr) != bits))


def white_clusters(gray):
    """White blobs enclosed by a large dark region, grouped by proximity (best first)."""
    h, w = gray.shape
    g = cv2.GaussianBlur(gray, (0, 0), 1.0)
    t, _ = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    dark = (g < t).astype(np.uint8) * 255
    cnts, hier = cv2.findContours(dark, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hier is None:
        return []
    hier = hier[0]
    areas = [cv2.contourArea(c) for c in cnts]
    holes = []
    for i, c in enumerate(cnts):
        p = hier[i][3]
        if p < 0 or areas[i] < 12 or areas[i] > 0.1 * w * h or areas[p] < 6 * areas[i]:
            continue
        holes.append((i, p, cv2.boundingRect(c), areas[i]))
    if len(holes) < 1:
        return []
    holes.sort(key=lambda x: -x[3])
    holes = holes[:150]
    n = len(holes)
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for a in range(n):
        for b in range(a + 1, n):
            if holes[a][1] != holes[b][1]:
                continue
            xa, ya, wa, ha = holes[a][2]
            xb, yb, wb, hb = holes[b][2]
            gap = max(max(xa, xb) - min(xa + wa, xb + wb), max(ya, yb) - min(ya + ha, yb + hb))
            if gap < 1.3 * max(wa, ha, wb, hb):
                parent[find(a)] = find(b)
    groups = {}
    for k in range(n):
        groups.setdefault(find(k), []).append(k)
    out = []
    for g_ in groups.values():
        area = sum(holes[k][3] for k in g_)
        pts = np.concatenate([cnts[holes[k][0]].reshape(-1, 2) for k in g_]).astype(np.float32)
        out.append((area, pts))
    out.sort(key=lambda x: -x[0])
    return [p for _, p in out[:4]]


def refine_pyramid(gray, H, canvas, speed=0.0):
    cell = _side(corners_of(H)) / 7.0
    first = float(np.clip(0.7 * speed, 0.45 * cell, 1.3 * cell))
    cc = None
    for extra, it in ((first, 40), (0.18 * cell, 50), (0.0, 80)):
        r = refine(gray, H, canvas, extra, it)
        if r is None:
            return None
        H, cc = r
    return H, cc


def accept(gray, H, cc, bits):
    if cc < 0.6:
        return False
    mm = verify(gray, H, bits)
    return mm is not None and mm <= 1


SEARCH_BUDGET_S = 0.12      # give up the full-frame search after this long (clutter / noise)


def search_pose(gray):
    t_end = time.perf_counter() + SEARCH_BUDGET_S
    for marker_id in BLACK_BOARD_IDS:
        canvas, bits, tbox = get_template(marker_id)
        for pts in white_clusters(gray)[:3]:
            if time.perf_counter() > t_end:
                return None
            dbox = cv2.boxPoints(cv2.minAreaRect(cv2.convexHull(pts))).astype(np.float32)
            cands = []
            for rev in (False, True):
                d = dbox[::-1] if rev else dbox
                for r in range(4):
                    H0 = cv2.getPerspectiveTransform(tbox, np.roll(d, r, axis=0)).astype(np.float64)
                    mm = verify(gray, H0, bits)
                    cands.append((99 if mm is None else mm, len(cands), H0))
            cands.sort(key=lambda x: (x[0], x[1]))
            for mm0, _, H0 in cands[:3]:
                if mm0 > 14 or time.perf_counter() > t_end:
                    break
                r = refine_pyramid(gray, H0, canvas)
                if r and accept(gray, r[0], r[1], bits):
                    return marker_id, r[0]
    return None


class Tracker:
    def __init__(self):
        self.last = None          # (id, corners)
        self.prev = None
        self.method = None
        self.lock = threading.Lock()

    def reset(self):
        self.last = self.prev = self.method = None

    def update(self, marker_id, corners, method):
        self.prev, self.last = self.last, (marker_id, np.asarray(corners, np.float32))
        self.method = method

    def predict(self):
        marker_id, c = self.last
        if self.prev is not None and self.prev[0] == marker_id:
            v = c - self.prev[1]
            return marker_id, c + v, float(np.linalg.norm(v, axis=1).mean())
        return marker_id, c, 0.0


TRACKER = Tracker()


def black_board_detect(gray):
    """-> (id, corners, method) or None"""
    if TRACKER.last is not None:
        marker_id, cpred, speed = TRACKER.predict()
        canvas, bits, _ = get_template(marker_id)
        for start, spd in ((cpred, speed), (TRACKER.last[1], speed)):
            r = refine_pyramid(gray, H_from_corners(start), canvas, spd)
            if r and accept(gray, r[0], r[1], bits):
                return marker_id, corners_of(r[0]), "track"
    r = search_pose(gray)
    if r:
        return r[0], corners_of(r[1]), "pattern"
    return None


def pack(marker_id, c, w, h, method, ms):
    xs, ys = [float(p[0]) for p in c], [float(p[1]) for p in c]
    pts = [{"x": x, "y": y} for x, y in zip(xs, ys)]
    return {"active": True, "pixelX": sum(xs) / 4, "pixelY": sum(ys) / 4, "corners": pts,
            "markerId": int(marker_id), "frameWidth": w, "frameHeight": h,
            "markers": [{"markerId": int(marker_id), "corners": pts}],
            "method": method, "ms": round(ms, 1)}


def detect_standard(frame, gray):
    h, w = frame.shape[:2]
    corners, ids = (), None
    for _name, detector in DETECTORS:
        corners, ids, _ = detector.detectMarkers(gray)
        if ids is not None and len(ids) > 0:
            break
    if ids is not None and len(ids) > 0:
        marker_ids = ids.flatten()
        c = corners[0][0]
        xs = [float(np.asarray(p).reshape(-1)[0]) for p in c]
        ys = [float(np.asarray(p).reshape(-1)[1]) for p in c]
        return {
            "active": True,
            "pixelX": sum(xs) / 4,
            "pixelY": sum(ys) / 4,
            "corners": [{"x": x, "y": y} for x, y in zip(xs, ys)],
            "markerId": int(marker_ids[0]),
            "frameWidth": w,
            "frameHeight": h,
            "markers": [
                {
                    "markerId": int(marker_id),
                    "corners": [
                        {
                            "x": float(np.asarray(point).reshape(-1)[0]),
                            "y": float(np.asarray(point).reshape(-1)[1]),
                        }
                        for point in marker_corners
                    ],
                }
                for marker_corners, marker_id in zip(corners, marker_ids)
            ],
            "method": "std",
        }
    return None


def detect_marker(frame):
    t0 = time.perf_counter()
    h, w = frame.shape[:2]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
    with TRACKER.lock:
        if TRACKER.method in ("track", "pattern"):
            bb = black_board_detect(gray)
            if bb is not None:
                TRACKER.update(bb[0], bb[1], bb[2])
                return pack(bb[0], bb[1], w, h, bb[2], (time.perf_counter() - t0) * 1000)
        res = detect_standard(frame, gray)
        if res is not None:
            TRACKER.update(res["markerId"], [(p["x"], p["y"]) for p in res["corners"]], "std")
            res["ms"] = round((time.perf_counter() - t0) * 1000, 1)
            return res
        bb = black_board_detect(gray)
        if bb is not None:
            TRACKER.update(bb[0], bb[1], bb[2])
            return pack(bb[0], bb[1], w, h, bb[2], (time.perf_counter() - t0) * 1000)
        TRACKER.reset()
    return {**EMPTY, "frameWidth": w, "frameHeight": h, "ms": round((time.perf_counter() - t0) * 1000, 1)}


def set_state(result):
    with state_lock:
        marker_state.clear()
        marker_state.update(result)


def capture_loop():
    while True:
        cap = cv2.VideoCapture(CAMERA_INDEX)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        if not cap.isOpened():
            print(f"[camera] could not open index {CAMERA_INDEX} (in use by browser?), retrying...")
            time.sleep(2)
            continue
        print("[camera] opened")
        while True:
            ok, frame = cap.read()
            if not ok:
                print("[camera] read failed, reopening")
                break
            try:
                set_state(detect_marker(frame))
            except Exception:
                traceback.print_exc()
            time.sleep(0.03)
        cap.release()
        time.sleep(1)


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/marker":
            with state_lock:
                payload = dict(marker_state)
            self._send_json(payload)
        elif self.path == "/health":
            self._send_json({"ok": True, "serverCamera": USE_SERVER_CAMERA})
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != "/frame":
            self.send_response(404)
            self.end_headers()
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            data = np.frombuffer(self.rfile.read(n), dtype=np.uint8)
            frame = cv2.imdecode(data, cv2.IMREAD_COLOR)
            if frame is None:
                raise ValueError("bad image")
            result = detect_marker(frame)
            set_state(result)
            self._send_json(result)
        except Exception:
            traceback.print_exc()
            self.send_response(400)
            self._cors()
            self.end_headers()

    def log_message(self, format, *args):
        return


if __name__ == "__main__":
    ensure_marker_file()
    if USE_SERVER_CAMERA:
        threading.Thread(target=capture_loop, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Aruco tracker server on http://localhost:{PORT} (serverCamera={USE_SERVER_CAMERA})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()