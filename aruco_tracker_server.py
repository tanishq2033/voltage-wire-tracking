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

DICTIONARY = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_ARUCO_ORIGINAL)
DETECTOR_PARAMETERS = cv2.aruco.DetectorParameters()
DETECTOR_PARAMETERS.adaptiveThreshWinSizeMin = 3
DETECTOR_PARAMETERS.adaptiveThreshWinSizeMax = 49
DETECTOR_PARAMETERS.adaptiveThreshWinSizeStep = 4
DETECTOR_PARAMETERS.minMarkerPerimeterRate = 0.01
DETECTOR_PARAMETERS.maxMarkerPerimeterRate = 4.0
DETECTOR_PARAMETERS.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
DETECTOR = cv2.aruco.ArucoDetector(DICTIONARY, DETECTOR_PARAMETERS)

EMPTY = {"active": False, "pixelX": None, "pixelY": None, "corners": [],
         "markerId": None, "frameWidth": 0, "frameHeight": 0, "markers": []}
marker_state = dict(EMPTY)
state_lock = threading.Lock()
latest_frame = None
previous_track = {"corners": None, "markerId": None}


def smooth_detection(result):
    if not result.get("active") or not result.get("corners"):
        previous_track["corners"] = None
        previous_track["markerId"] = None
        return smooth_detection(result)

    raw = np.asarray([[p["x"], p["y"]] for p in result["corners"]], dtype=np.float32)
    marker_id = result.get("markerId")
    previous = previous_track["corners"]

    if previous is not None and previous_track["markerId"] == marker_id:
        previous = np.asarray(previous, dtype=np.float32)
        side = max(
            np.linalg.norm(raw[i] - raw[(i + 1) % 4])
            for i in range(4)
        )
        movement = float(np.mean([
            np.linalg.norm(raw[i] - previous[i]) for i in range(4)
        ]))

        # Fast movement should follow closely; tiny jitter is heavily suppressed.
        response = 0.82 if movement > side * 0.18 else 0.58
        raw = response * raw + (1.0 - response) * previous

    smoothed = [{"x": float(p[0]), "y": float(p[1])} for p in raw]
    center = np.mean(raw, axis=0)
    result["pixelX"] = float(center[0])
    result["pixelY"] = float(center[1])
    result["corners"] = smoothed
    result["markers"] = [
        {"markerId": marker_id, "corners": smoothed}
    ]
    previous_track["corners"] = smoothed
    previous_track["markerId"] = marker_id
    return result


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
        img = cv2.aruco.generateImageMarker(DICTIONARY, 1023, MARKER_SIZE_PX)
        img = cv2.copyMakeBorder(img, 100, 100, 100, 100, cv2.BORDER_CONSTANT, value=255)
        if not cv2.imwrite(str(OUTPUT_FILE), img):
            raise RuntimeError(f"Could not generate ArUco marker at {OUTPUT_FILE}")
        print(f"[marker] generated valid ArUco marker template at {OUTPUT_FILE}")
    else:
        print(f"[marker] using existing marker template at {OUTPUT_FILE}")


def detect_marker(frame):
    h, w = frame.shape[:2]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    corners, ids, _ = DETECTOR.detectMarkers(gray)
    if ids is not None and len(ids) > 0:
        marker_ids = ids.flatten()
        c = corners[0][0]
        xs = [float(np.asarray(p).reshape(-1)[0]) for p in c]
        ys = [float(np.asarray(p).reshape(-1)[1]) for p in c]
        result = {
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
        }
        return result
    pattern = detect_white_cell_pattern(frame)
    if pattern:
        result = {
            "active": True,
            "pixelX": pattern["pixelX"],
            "pixelY": pattern["pixelY"],
            "corners": pattern["corners"],
            "markerId": 1023,
            "frameWidth": w,
            "frameHeight": h,
            "markers": [{
                "markerId": 1023,
                "corners": pattern["corners"],
            }],
        }
        return smooth_detection(result)
    return smooth_detection({**EMPTY, "frameWidth": w, "frameHeight": h})


def detect_white_cell_pattern(frame):
    frame_h, frame_w = frame.shape[:2]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    binary_maps = [
        cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                               cv2.THRESH_BINARY, 31, 7),
        cv2.threshold(gray, 205, 255, cv2.THRESH_BINARY)[1],
    ]

    cells = []
    for binary in binary_maps:
        contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            area = cv2.contourArea(contour)
            if area < 80 or area > 18000:
                continue
            x, y, cw, ch = cv2.boundingRect(contour)
            ratio = cw / float(ch)
            if 0.45 <= ratio <= 2.2:
                cells.append((x, y, cw, ch, area))

    if len(cells) < 4:
        return None

    best = None
    best_score = -1
    for i, a in enumerate(cells):
        ax, ay, aw, ah, aa = a
        acx, acy = ax + aw / 2, ay + ah / 2
        nearby = []
        for b in cells:
            bx, by, bw, bh, ba = b
            bcx, bcy = bx + bw / 2, by + bh / 2
            if abs(bcx - acx) <= 520 and abs(bcy - acy) <= 520:
                nearby.append(b)
        if len(nearby) < 4:
            continue
        xs = [x for x, y, cw, ch, area in nearby]
        ys = [y for x, y, cw, ch, area in nearby]
        ex = [x + cw for x, y, cw, ch, area in nearby]
        ey = [y + ch for x, y, cw, ch, area in nearby]
        cluster_w = max(ex) - min(xs)
        cluster_h = max(ey) - min(ys)
        if cluster_w < 35 or cluster_h < 35:
            continue
        if cluster_w > 700 or cluster_h > 700:
            continue
        square_like = sum(
            1 for x, y, cw, ch, area in nearby
            if 0.55 <= cw / float(ch) <= 1.8
        )
        if square_like < 4:
            continue
        spread_x = len({x for x, y, cw, ch, area in nearby if abs(y - acy) <= 220})
        spread_y = len({y for x, y, cw, ch, area in nearby if abs(x - acx) <= 220})
        if spread_x < 2 or spread_y < 2:
            continue
        score = len(nearby) * 100 - abs(cluster_w - cluster_h)
        if score > best_score:
            best = (min(xs), min(ys), max(ex), max(ey), nearby)
            best_score = score

    if best is None:
        return None

    x1, y1, x2, y2, nearby = best
    pad_x = max(12, int((x2 - x1) * 0.12))
    pad_y = max(12, int((y2 - y1) * 0.12))
    x1 -= pad_x
    y1 -= pad_y
    x2 += pad_x
    y2 += pad_y
    x1 = max(0, int(x1))
    y1 = max(0, int(y1))
    x2 = min(frame_w, int(x2))
    y2 = min(frame_h, int(y2))
    corners = [
        {"x": float(x1), "y": float(y1)},
        {"x": float(x2), "y": float(y1)},
        {"x": float(x2), "y": float(y2)},
        {"x": float(x1), "y": float(y2)},
    ]
    return {
        "pixelX": (x1 + x2) / 2,
        "pixelY": (y1 + y2) / 2,
        "corners": corners,
    }


def set_state(result):
    with state_lock:
        marker_state.clear()
        marker_state.update(result)


def capture_loop():
    global latest_frame
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
                with state_lock:
                    latest_frame = frame.copy()
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