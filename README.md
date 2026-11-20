# Non-Invasive Voltage Detection & Wire Tracking System — Prototype

This package has two parts:

- `esp32/esp32_voltage_node/esp32_voltage_node.ino` — Part A, ESP32 firmware
- `website/` — Part B, the browser dashboard (HTML/CSS/JS, no server needed)

Architecture: **ESP32 (sensor + Wi-Fi) → WebSocket/HTTP → Browser → Webcam + ArUco tracking → combined HIGH/LOW marker on the wall view.**
The browser talks directly to the ESP32 over your local Wi-Fi — no cloud, no database, no Node backend.

---

## 1. Upload the ESP32 code

1. Open `esp32_voltage_node.ino` in the Arduino IDE.
2. Install these libraries via **Tools > Manage Libraries**:
   - `ArduinoJson` (Benoit Blanchon)
   - `WebSockets` (Markus Sattler / Links2004)
   - ESP32 board package (`esp32` by Espressif Systems), installed via **Boards Manager** if not already present.
3. Select **Tools > Board >** your ESP32 dev board (e.g. "ESP32 Dev Module") and the correct COM/serial port.
4. Edit the top of the sketch:
   ```cpp
   const char* WIFI_SSID     = "YOUR_WIFI_NAME";
   const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
   float VOLTAGE_HIGH_THRESHOLD = 100.0; // tune to your sensor
   ```
5. Replace the placeholder logic inside `readVoltage()` with your existing non-invasive voltage sensor code. It must return a `float` in volts — nothing else in the sketch or website needs to change.
6. Click **Upload**.

## 2. Connect ESP32 and laptop to the same Wi-Fi

- The ESP32 must join the **same Wi-Fi network** as the laptop running the website (same router/hotspot, 2.4GHz — most ESP32 boards don't support 5GHz).
- If you use a phone hotspot, connect both the ESP32 and the laptop to that hotspot.

## 3. Find the ESP32's IP address

- Open **Tools > Serial Monitor** in the Arduino IDE (baud rate `115200`) right after upload/reset.
- You'll see:
  ```
  Connected! ESP32 IP address: 192.168.1.42
  Use this IP in the website's ESP32 IP field.
  ```
- Note this IP — you'll type it into the website.

## 4. Start the website

No build step or server is required for a demo:

- **Option A (simplest):** double-click `website/index.html` to open it directly in Chrome or Edge.
- **Option B (recommended for camera permissions):** serve it locally, e.g. from the `website/` folder run:
  ```
  python -m http.server 8000
  ```
  then open `http://localhost:8000` in your browser. Some browsers restrict camera access on `file://` pages, so Option B is more reliable.

## 5. How the website receives ESP32 data

- On page load, type the ESP32's IP (e.g. `192.168.1.42`) into the **ESP32 Connection** panel and click **Connect**.
- The website opens `ws://<ESP32-IP>:81/` and listens for JSON messages the ESP32 broadcasts continuously:
  ```json
  { "voltage": 230.5, "status": "HIGH", "device": "connected" }
  ```
- If the WebSocket can't connect (blocked network, older browser, etc.), the website automatically falls back to polling `http://<ESP32-IP>/data` every 500 ms — you don't need to do anything differently.
- The **ESP32: 🟢 CONNECTED / 🔴 DISCONNECTED** badge and the Voltage/Status readout update live from this stream. You never type a voltage value manually.

## 6. Attach and use the ArUco marker

1. Print an ArUco marker (any ID from the standard 5×5 dictionary — e.g. use a free generator such as `https://chev.me/arucogen/`, dictionary "Original ArUco", marker size ~5–8 cm).
2. Stick the printed marker flat on the ESP32 enclosure (or a small board attached to it), facing the camera.
3. Click **Start Camera** on the website — it will request webcam permission, then begin detecting the marker automatically.
4. As you move the ESP32 across the wall, the marker's on-screen position updates continuously (`Tracking: 🟢 ACTIVE`). If the marker is blocked or out of frame, it switches to `🔴 LOST` after a brief tolerance window (to avoid flicker).
5. For testing without a live camera, use **Upload Test Image** to load a photo containing the printed marker.

## 7. Calibrate the wall

1. Measure (approximately) the wall area the camera is framing: width, height, and how far the camera is from the wall.
2. Enter these into the **Wall Calibration** panel (defaults: 10 ft × 8 ft wall, 3 ft camera distance) and click **Apply Calibration**.
3. The website converts the marker's pixel position into approximate feet using simple proportional scaling across the visible frame:
   ```
   X (ft) = (pixelX / frameWidth)  × wallWidth
   Y (ft) = (pixelY / frameHeight) × wallHeight
   ```
   This assumes the camera view is reasonably aligned to the wall — it's an approximation intended for a first working version, not a precise homography. A later version can calibrate against 4 clicked wall-corner reference points for better accuracy.

## 8. Mark the wire (v1, manual)

1. With the camera running and pointed at the wall, click **Mark Wire Path**.
2. Click a few points along the visible wire/conduit/switchboard line in the video feed — a yellow line will be drawn connecting them.
3. Click **Mark Wire Path** again (now labeled "Stop Marking") to stop, or **Clear Wire** to start over.
4. When the tracked ESP32 marker passes near this marked path **and** the ESP32 reports `HIGH`, the wire segment near the marker is highlighted in red and the device marker itself turns red with a "HIGH" label. When `LOW`, the marker is green with a "LOW" label.

## 9. Test HIGH and LOW conditions

- **With the placeholder demo code** (before you plug in your real sensor): the sketch reads `analogRead(34)` and maps it 0–250V. Connect a potentiometer or vary the voltage on pin 34 (0–3.3V) to swing the simulated reading above/below `VOLTAGE_HIGH_THRESHOLD` and watch the website flip between 🔴 HIGH and 🟢 LOW live.
- **With your real sensor:** bring the non-contact probe near a live wire (HIGH) and then away from it or near an unpowered wire (LOW), and confirm the dashboard, camera overlay marker color/label, and wire highlight all update accordingly.
- You can also test disconnect handling: power off the ESP32 and confirm the website shows `ESP32: 🔴 DISCONNECTED` within a second or two; power it back on and confirm it reconnects (click **Connect** again if the auto-retry via polling doesn't immediately catch the WebSocket coming back).

---

## File structure

```
esp32/
  esp32_voltage_node/
    esp32_voltage_node.ino     <- Part A: ESP32 firmware

website/
  index.html                  <- dashboard layout
  style.css                   <- dashboard styling
  esp32Connection.js          <- WebSocket/HTTP client, ESP32 data stream
  camera.js                   <- webcam + test-image handling
  tracking.js                 <- ArUco marker detection (js-aruco)
  calibration.js              <- pixel→feet conversion + wire marking
  app.js                      <- glue: UI wiring, render loop, combine logic
  lib/
    aruco.js, cv.js, svd.js   <- js-aruco library (bundled locally, MIT licensed)
```

## Notes for the demo / report

- Only `readVoltage()` in the `.ino` file needs to be replaced with your real sensor logic — everything downstream (JSON format, WebSocket/HTTP endpoints, website) stays the same.
- The system requires no database and no internet/cloud connection — ESP32 and laptop just need to share a local Wi-Fi network.
- Wire detection is manual in this version by design; the code is structured so a later OpenCV.js-based auto-detection module can plug into the same `WireMarking` interface (`addPoint`, `getPoints`, `isNear`) without touching the rest of the app.
