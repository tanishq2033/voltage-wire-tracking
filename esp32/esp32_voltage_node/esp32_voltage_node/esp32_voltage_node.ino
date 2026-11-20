#include <Wire.h>
#include <Adafruit_ADS1X15.h>
#include <U8g2lib.h>
#include <math.h>
#include <WiFi.h>
#include <WebServer.h>
#include <WebSocketsServer.h>   // Library: "WebSockets" by Markus Sattler (Links2004)

// ======================================
// FEATURE SWITCH
// ======================================

// 1 = Wi-Fi + website on
// 0 = Wi-Fi fully off (your original offline behavior)
#define ENABLE_WIFI 1

// ======================================
// PIN CONFIGURATION
// ======================================

#define SDA_PIN       21
#define SCL_PIN       22
#define BUZZER_PIN    25

#define ADC_ADDRESS   0x48

// ======================================
// WIFI CONFIGURATION
// ======================================

const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

const unsigned long WIFI_RETRY_MS = 10000;

WebServer server(80);
WebSocketsServer webSocket(81);

bool servicesStarted = false;
bool wifiWasConnected = false;
unsigned long lastWifiAttempt = 0;

// ======================================
// HARDWARE OBJECTS
// ======================================

Adafruit_ADS1115 ads;

U8G2_SH1106_128X64_NONAME_F_HW_I2C display(
  U8G2_R0,
  U8X8_PIN_NONE
);

// ======================================
// ADC CONFIGURATION
// ======================================

const int NUM_SAMPLES = 160;
const float ADC_LSB_MV = 0.125;

// Network and buzzer are serviced every this many samples
// so the web page and beeps stay responsive during sampling.
const int SERVICE_EVERY = 32;

// ======================================
// EXPERIMENTAL DETECTION THRESHOLDS
// ======================================

const float LOW_LEVEL    = 12.0;
const float DETECT_LEVEL = 19.0;
const float STRONG_LEVEL = 40.0;

// Hysteresis: lower thresholds for returning
const float BACKGROUND_EXIT = 10.0;
const float LOW_EXIT        = 17.0;
const float DETECT_EXIT     = 36.0;

// ======================================
// FILTERING
// ======================================

const float FILTER_ALPHA = 0.35;

float filteredRMS = 0;
bool firstReading = true;

const int CONFIRM_COUNT = 2;

int candidateCount = 0;

// ======================================
// DETECTION STATES
// ======================================

enum FieldState {
  BACKGROUND,
  LOW_FIELD,
  FIELD_DETECTED,
  STRONG_FIELD
};

FieldState currentState = BACKGROUND;
FieldState candidateState = BACKGROUND;

// ======================================
// SENSOR VALUES
// ======================================

float rmsMV = 0;
float peakToPeakMV = 0;
float dcMV = 0;
float sampleRateHz = 0;

// ======================================
// TIMERS
// ======================================

const unsigned long WS_INTERVAL_MS = 200;

unsigned long lastDisplayUpdate = 0;
unsigned long lastSerialUpdate = 0;
unsigned long lastWsUpdate = 0;

// ======================================
// BUZZER VARIABLES
// ======================================

unsigned long lastBeepStart = 0;
unsigned long beepDuration = 0;
unsigned long beepPeriod = 0;

bool buzzerActive = false;

// ======================================
// STATUS TEXT
// ======================================

const char* getStatusText(FieldState state) {

  switch (state) {

    case BACKGROUND:
      return "NO FIELD DETECTED";

    case LOW_FIELD:
      return "WEAK FIELD";

    case FIELD_DETECTED:
      return "FIELD DETECTED";

    case STRONG_FIELD:
      return "POSSIBLE WIRE";
  }

  return "UNKNOWN";
}

const char* getStrengthText(FieldState state) {

  switch (state) {

    case BACKGROUND:
      return "NONE";

    case LOW_FIELD:
      return "LOW";

    case FIELD_DETECTED:
      return "MEDIUM";

    case STRONG_FIELD:
      return "STRONG";
  }

  return "UNKNOWN";
}

// ======================================
// BUZZER CONTROL
// ======================================

void updateBuzzer() {

  unsigned long now = millis();

  // Stop buzzer in background

  if (currentState == BACKGROUND) {

    if (buzzerActive) {
      noTone(BUZZER_PIN);
      buzzerActive = false;
    }

    return;
  }

  unsigned long frequency = 1000;

  switch (currentState) {

    case LOW_FIELD:
      beepPeriod = 1500;
      beepDuration = 80;
      frequency = 1000;
      break;

    case FIELD_DETECTED:
      beepPeriod = 900;
      beepDuration = 120;
      frequency = 1500;
      break;

    case STRONG_FIELD:
      beepPeriod = 450;
      beepDuration = 160;
      frequency = 2000;
      break;

    default:
      return;
  }

  // Start a new beep

  if (!buzzerActive &&
      (lastBeepStart == 0 ||
       now - lastBeepStart >= beepPeriod)) {

    tone(BUZZER_PIN, frequency);

    buzzerActive = true;
    lastBeepStart = now;
  }

  // Stop after beep duration

  if (buzzerActive &&
      now - lastBeepStart >= beepDuration) {

    noTone(BUZZER_PIN);

    buzzerActive = false;
  }
}

// ======================================
// JSON PAYLOAD (shared by HTTP and WebSocket)
// ======================================

String buildJson() {

  char buf[240];

  snprintf(buf, sizeof(buf),
    "{\"rms\":%.2f,\"raw\":%.2f,\"pp\":%.2f,\"dc\":%.2f,"
    "\"fs\":%.0f,\"status\":\"%s\",\"strength\":\"%s\",\"state\":%d}",
    (double)filteredRMS,
    (double)rmsMV,
    (double)peakToPeakMV,
    (double)dcMV,
    (double)sampleRateHz,
    getStatusText(currentState),
    getStrengthText(currentState),
    (int)currentState);

  return String(buf);
}

// ======================================
// WEB PAGE
// ======================================

#if ENABLE_WIFI

static const char webpage[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WIREMAP Detector</title>
  <style>
    body{font-family:Arial,sans-serif;background:#101827;color:#f4f7fb;margin:0;padding:20px}
    .wrap{max-width:520px;margin:auto}
    h1{font-size:24px;margin-bottom:6px}
    .sub{color:#aab7c8;margin-bottom:20px}
    .card{background:#1d2a3d;border-radius:14px;padding:18px;margin:12px 0}
    .status{font-size:22px;font-weight:bold;color:#64dca0}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .value{font-size:25px;font-weight:bold;margin-top:8px}
    .unit{font-size:13px;color:#aab7c8}
    .bar{height:12px;background:#34445b;border-radius:8px;overflow:hidden;margin-top:12px}
    #fill{height:100%;width:0;background:#43c78b;transition:width .15s}
    .foot{font-size:12px;color:#aab7c8;text-align:center;margin-top:18px}
  </style>
</head>
<body>
<div class="wrap">
  <h1>WIREMAP DETECTOR</h1>
  <div class="sub">Live sensor monitoring over ESP32 Wi-Fi</div>
  <div class="card">
    <div class="unit">DETECTION STATUS</div>
    <div class="status" id="status">Connecting...</div>
    <div class="bar"><div id="fill"></div></div>
    <div class="unit" style="margin-top:8px">Signal: <span id="strength">--</span></div>
  </div>
  <div class="grid">
    <div class="card"><div class="unit">FILTERED RMS</div><div class="value" id="rms">--</div><div class="unit">mV</div></div>
    <div class="card"><div class="unit">PEAK-TO-PEAK</div><div class="value" id="pp">--</div><div class="unit">mV</div></div>
    <div class="card"><div class="unit">DC LEVEL</div><div class="value" id="dc">--</div><div class="unit">mV</div></div>
    <div class="card"><div class="unit">RAW RMS</div><div class="value" id="raw">--</div><div class="unit">mV</div></div>
  </div>
  <div class="foot">Live stream via WebSocket &middot; sample rate <span id="fs">--</span> Hz</div>
</div>
<script>
function apply(d){
  document.getElementById('status').textContent=d.status;
  document.getElementById('strength').textContent=d.strength;
  document.getElementById('rms').textContent=Number(d.rms).toFixed(2);
  document.getElementById('pp').textContent=Number(d.pp).toFixed(2);
  document.getElementById('dc').textContent=Number(d.dc).toFixed(2);
  document.getElementById('raw').textContent=Number(d.raw).toFixed(2);
  document.getElementById('fs').textContent=d.fs;
  var f=document.getElementById('fill');
  f.style.width=Math.min(Number(d.rms)/80*100,100)+'%';
  f.style.background=d.state===3?'#ef6464':'#43c78b';
}
function connect(){
  var ws=new WebSocket('ws://'+location.hostname+':81/');
  ws.onmessage=function(e){apply(JSON.parse(e.data));};
  ws.onclose=function(){
    document.getElementById('status').textContent='Connection lost, retrying...';
    setTimeout(connect,1000);
  };
}
connect();
</script>
</body>
</html>
)rawliteral";

// ======================================
// WEB HANDLERS
// ======================================

void handleRoot() {
  server.send_P(200, "text/html", webpage);
}

// HTTP endpoint for external pages (e.g. your ArUco tracking website).
// CORS header lets a page served from another origin fetch it.
void handleData() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", buildJson());
}

void handleNotFound() {
  server.send(404, "text/plain", "Not found");
}

void webSocketEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {

  if (type == WStype_CONNECTED) {
    String json = buildJson();
    webSocket.sendTXT(num, json);
  }
}

void startWebServices() {

  server.on("/", HTTP_GET, handleRoot);
  server.on("/data", HTTP_GET, handleData);
  server.onNotFound(handleNotFound);
  server.begin();

  webSocket.begin();
  webSocket.onEvent(webSocketEvent);

  servicesStarted = true;

  Serial.print("Web page:  http://");
  Serial.println(WiFi.localIP());
  Serial.print("Data API:  http://");
  Serial.print(WiFi.localIP());
  Serial.println("/data");
  Serial.print("WebSocket: ws://");
  Serial.print(WiFi.localIP());
  Serial.println(":81/");
}

#endif

// ======================================
// WIFI (non-blocking)
// ======================================

bool wifiConnected() {

#if ENABLE_WIFI
  return WiFi.status() == WL_CONNECTED;
#else
  return false;
#endif
}

void startWiFi() {

#if ENABLE_WIFI

  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  lastWifiAttempt = millis();

  Serial.println("Wi-Fi connecting in background...");

#else

  WiFi.mode(WIFI_OFF);

  Serial.println("Wi-Fi disabled (ENABLE_WIFI = 0)");

#endif
}

// Reports connect events, starts the web services once, and retries if the link is down.
void serviceWiFi() {

#if ENABLE_WIFI

  unsigned long now = millis();

  bool connected = (WiFi.status() == WL_CONNECTED);

  if (connected && !wifiWasConnected) {

    Serial.println();
    Serial.println("WiFi Connected!");

    Serial.print("Network: ");
    Serial.println(WIFI_SSID);

    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());

    Serial.print("Signal Strength: ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");

    if (!servicesStarted) {
      startWebServices();
    }
  }

  if (!connected && wifiWasConnected) {
    Serial.println("WiFi link lost, retrying...");
  }

  wifiWasConnected = connected;

  if (!connected && now - lastWifiAttempt >= WIFI_RETRY_MS) {

    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    lastWifiAttempt = now;
  }

#endif
}

// Handles pending browser requests and WebSocket traffic.
void serviceNetwork() {

#if ENABLE_WIFI

  if (servicesStarted) {
    server.handleClient();
    webSocket.loop();
  }

#endif
}

// ======================================
// SENSOR ACQUISITION
// ======================================

void readSensor() {

  long sum = 0;

  int16_t minimumValue = 32767;
  int16_t maximumValue = -32768;

  static int16_t samples[NUM_SAMPLES];

  unsigned long t0 = micros();

  // Collect ADC samples

  for (int i = 0; i < NUM_SAMPLES; i++) {

    int16_t value = ads.readADC_SingleEnded(0);

    samples[i] = value;

    sum += value;

    if (value < minimumValue)
      minimumValue = value;

    if (value > maximumValue)
      maximumValue = value;

    // Keep the website and buzzer responsive during sampling

    if (i % SERVICE_EVERY == SERVICE_EVERY - 1) {
      serviceNetwork();
      updateBuzzer();
    }
  }

  unsigned long elapsed = micros() - t0;

  // Effective sample rate (includes the brief network servicing above).
  // Aim for well above 200 Hz so 50 Hz mains is sampled cleanly.
  if (elapsed > 0) {
    sampleRateHz = (float)NUM_SAMPLES * 1000000.0f / (float)elapsed;
  }

  // Calculate average

  float average = (float)sum / NUM_SAMPLES;

  // Calculate RMS after removing DC offset

  double sumSquares = 0;

  for (int i = 0; i < NUM_SAMPLES; i++) {

    float deviation = samples[i] - average;

    sumSquares += deviation * deviation;
  }

  float rmsCounts = sqrt(sumSquares / NUM_SAMPLES);

  // Convert to millivolts

  rmsMV = rmsCounts * ADC_LSB_MV;

  peakToPeakMV =
    (maximumValue - minimumValue) * ADC_LSB_MV;

  dcMV = average * ADC_LSB_MV;

  // Exponential smoothing

  if (firstReading) {

    filteredRMS = rmsMV;
    firstReading = false;

  } else {

    filteredRMS =
      FILTER_ALPHA * rmsMV +
      (1.0 - FILTER_ALPHA) * filteredRMS;
  }
}

// ======================================
// HYSTERESIS CLASSIFICATION
// ======================================

FieldState classifySignal(float value) {

  switch (currentState) {

    case BACKGROUND:

      if (value >= STRONG_LEVEL)
        return STRONG_FIELD;

      if (value >= DETECT_LEVEL)
        return FIELD_DETECTED;

      if (value >= LOW_LEVEL)
        return LOW_FIELD;

      return BACKGROUND;

    case LOW_FIELD:

      if (value >= STRONG_LEVEL)
        return STRONG_FIELD;

      if (value >= DETECT_LEVEL)
        return FIELD_DETECTED;

      if (value < BACKGROUND_EXIT)
        return BACKGROUND;

      return LOW_FIELD;

    case FIELD_DETECTED:

      if (value >= STRONG_LEVEL)
        return STRONG_FIELD;

      if (value < BACKGROUND_EXIT)
        return BACKGROUND;

      if (value < LOW_EXIT)
        return LOW_FIELD;

      return FIELD_DETECTED;

    case STRONG_FIELD:

      if (value < BACKGROUND_EXIT)
        return BACKGROUND;

      if (value < LOW_EXIT)
        return LOW_FIELD;

      if (value < DETECT_EXIT)
        return FIELD_DETECTED;

      return STRONG_FIELD;
  }

  return BACKGROUND;
}

// ======================================
// DETECTION PERSISTENCE
// ======================================

void updateDetection() {

  FieldState newState = classifySignal(filteredRMS);

  if (newState == candidateState) {

    candidateCount++;

  } else {

    candidateState = newState;
    candidateCount = 1;
  }

  if (candidateCount >= CONFIRM_COUNT) {

    currentState = candidateState;
  }
}

// ======================================
// SIGNAL STRENGTH BAR
// ======================================

void drawSignalBar() {

  // 80 mV represents full bar for display only

  int barWidth = (int)(filteredRMS / 80.0 * 120.0);

  barWidth = constrain(barWidth, 0, 120);

  display.drawFrame(3, 44, 122, 8);

  if (barWidth > 0) {
    display.drawBox(4, 45, barWidth, 6);
  }
}

// ======================================
// OLED DISPLAY
// ======================================

void updateOLED() {

  display.clearBuffer();

  // Header

  display.setFont(u8g2_font_6x10_tf);

  display.drawStr(2, 9, "WIREMAP DETECTOR");

  // "W" appears only while Wi-Fi is connected

  if (wifiConnected()) {
    display.drawStr(92, 9, "W");
  }

  display.drawStr(105, 9, "AC");

  display.drawHLine(0, 12, 128);

  // Main status

  display.setFont(u8g2_font_7x14B_tf);

  if (currentState == STRONG_FIELD) {

    display.drawStr(2, 29, "POSSIBLE WIRE");

    display.drawStr(2, 42, "DETECTED!");

  } else {

    display.drawStr(2, 31, getStatusText(currentState));

  }

  // Signal strength bar

  drawSignalBar();

  // Bottom information

  display.setFont(u8g2_font_5x8_tf);

  display.setCursor(2, 62);
  display.print("RMS:");

  display.print(filteredRMS, 1);
  display.print("mV");

  display.setCursor(76, 62);
  display.print("SIGNAL:");

  display.print(getStrengthText(currentState));

  display.sendBuffer();
}

// ======================================
// SERIAL MONITOR
// ======================================

void printSerialData() {

  Serial.print("RMS: ");
  Serial.print(filteredRMS, 2);

  Serial.print(" mV | P-P: ");
  Serial.print(peakToPeakMV, 2);

  Serial.print(" mV | DC: ");
  Serial.print(dcMV, 2);

  Serial.print(" mV | Fs: ");
  Serial.print(sampleRateHz, 0);

  Serial.print(" Hz | STATUS: ");

  Serial.print(getStatusText(currentState));

#if ENABLE_WIFI
  Serial.print(" | WIFI: ");
  Serial.print(wifiConnected() ? "CONNECTED" : "DISCONNECTED");
#endif

  Serial.println();
}

// ======================================
// SETUP
// ======================================

void setup() {

  Serial.begin(115200);

  pinMode(BUZZER_PIN, OUTPUT);

  noTone(BUZZER_PIN);

  // Initialize I2C

  Wire.begin(SDA_PIN, SCL_PIN);

  Wire.setClock(100000);

  // Initialize OLED first so the screen works immediately

  display.begin();

  display.clearBuffer();

  display.setFont(u8g2_font_6x10_tf);

  display.drawStr(0, 25, "WIREMAP DETECTOR");
  display.drawStr(0, 42, "Initializing...");

  display.sendBuffer();

  delay(500);

  // Initialize ADS1115

  if (!ads.begin(ADC_ADDRESS)) {

    display.clearBuffer();

    display.drawStr(0, 25, "ADS1115 ERROR");
    display.drawStr(0, 42, "Check connections");

    display.sendBuffer();

    Serial.println("ADS1115 not detected!");

    while (1) {
      delay(100);
    }
  }

  ads.setGain(GAIN_ONE);

  ads.setDataRate(RATE_ADS1115_860SPS);

  Serial.println("WIRE DETECTOR READY");

  // Ready screen

  display.clearBuffer();

  display.drawStr(0, 25, "SYSTEM READY");
  display.drawStr(0, 42, "Scanning...");

  display.sendBuffer();

  delay(500);

  // Wi-Fi starts in the background; sensing never waits for it

  startWiFi();
}

// ======================================
// MAIN LOOP
// ======================================

void loop() {

  // 1. Read sensor (services network + buzzer while sampling)

  readSensor();

  // 2. Update classification

  updateDetection();

  // 3. Update buzzer

  updateBuzzer();

  // 4. Wi-Fi status / reconnect / start web services

  serviceWiFi();
  serviceNetwork();

  unsigned long now = millis();

  // 5. Push a fresh reading to every open browser

#if ENABLE_WIFI
  if (servicesStarted && now - lastWsUpdate >= WS_INTERVAL_MS) {

    String json = buildJson();
    webSocket.broadcastTXT(json);

    lastWsUpdate = now;
  }
#endif

  // 6. OLED refresh

  if (now - lastDisplayUpdate >= 500) {

    updateOLED();

    lastDisplayUpdate = now;
  }

  // 7. Serial output

  if (now - lastSerialUpdate >= 1000) {

    printSerialData();

    lastSerialUpdate = now;
  }
}
