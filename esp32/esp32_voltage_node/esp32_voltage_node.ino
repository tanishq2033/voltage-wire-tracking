/*
  =====================================================================
  Non-Invasive Voltage Detection & Wire Tracking System
  PART A — ESP32 firmware
  Compatible with the website dashboard in this project.
  =====================================================================

  This sketch keeps the custom ADS1115 field-detection logic and adds the
  JSON output contract expected by the browser: {"voltage":..., "status":"HIGH"|"LOW", "device":"connected"}

  The website expects a live stream over WebSocket on port 81 and also accepts
  HTTP polling on http://<ESP32_IP>/data if WebSocket isn't available.
  =====================================================================
*/

#include <WiFi.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_ADS1X15.h>
#include <U8g2lib.h>
#include <math.h>

// ======================================
// PIN CONFIGURATION
// ======================================

#define SDA_PIN       21
#define SCL_PIN       22
#define BUZZER_PIN    25
#define ADC_ADDRESS   0x48

// ======================================
// WI-FI SETTINGS
// ======================================

const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// ======================================
// HARDWARE OBJECTS
// ======================================

Adafruit_ADS1115 ads;

U8G2_SH1106_128X64_NONAME_F_HW_I2C display(
  U8G2_R0,
  U8X8_PIN_NONE
);

WebServer httpServer(80);
WebSocketsServer wsServer(81);

// ======================================
// ADC CONFIGURATION
// ======================================

const int NUM_SAMPLES = 160;
const float ADC_LSB_MV = 0.125;

// ======================================
// EXPERIMENTAL DETECTION THRESHOLDS
// ======================================

const float LOW_LEVEL    = 12.0;
const float DETECT_LEVEL = 19.0;
const float STRONG_LEVEL = 40.0;

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
bool adsReady = false;

// ======================================
// TIMERS
// ======================================

unsigned long lastDisplayUpdate = 0;
unsigned long lastSerialUpdate = 0;
unsigned long lastPublish = 0;

// ======================================
// BUZZER VARIABLES
// ======================================

unsigned long lastBeepStart = 0;
unsigned long beepDuration = 0;
unsigned long beepPeriod = 0;

bool buzzerActive = false;

// ======================================
// WEBSITE PAYLOAD STATE
// ======================================

float lastVoltage = 0.0;
String lastStatus = "LOW";

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
// SENSOR ACQUISITION
// ======================================

void readSensor() {
  if (!adsReady) {
    rmsMV = 0;
    peakToPeakMV = 0;
    dcMV = 0;
    filteredRMS = 0;
    return;
  }

  long sum = 0;

  int16_t minimumValue = 32767;
  int16_t maximumValue = -32768;

  static int16_t samples[NUM_SAMPLES];

  for (int i = 0; i < NUM_SAMPLES; i++) {
    int16_t value = ads.readADC_SingleEnded(0);
    samples[i] = value;
    sum += value;

    if (value < minimumValue) minimumValue = value;
    if (value > maximumValue) maximumValue = value;
  }

  float average = (float)sum / NUM_SAMPLES;

  double sumSquares = 0;
  for (int i = 0; i < NUM_SAMPLES; i++) {
    float deviation = samples[i] - average;
    sumSquares += deviation * deviation;
  }

  float rmsCounts = sqrt(sumSquares / NUM_SAMPLES);

  rmsMV = rmsCounts * ADC_LSB_MV;
  peakToPeakMV = (maximumValue - minimumValue) * ADC_LSB_MV;
  dcMV = average * ADC_LSB_MV;

  if (firstReading) {
    filteredRMS = rmsMV;
    firstReading = false;
  } else {
    filteredRMS = FILTER_ALPHA * rmsMV + (1.0 - FILTER_ALPHA) * filteredRMS;
  }
}

// ======================================
// HYSTERESIS CLASSIFICATION
// ======================================

FieldState classifySignal(float value) {
  switch (currentState) {
    case BACKGROUND:
      if (value >= STRONG_LEVEL) return STRONG_FIELD;
      if (value >= DETECT_LEVEL) return FIELD_DETECTED;
      if (value >= LOW_LEVEL) return LOW_FIELD;
      return BACKGROUND;

    case LOW_FIELD:
      if (value >= STRONG_LEVEL) return STRONG_FIELD;
      if (value >= DETECT_LEVEL) return FIELD_DETECTED;
      if (value < BACKGROUND_EXIT) return BACKGROUND;
      return LOW_FIELD;

    case FIELD_DETECTED:
      if (value >= STRONG_LEVEL) return STRONG_FIELD;
      if (value < BACKGROUND_EXIT) return BACKGROUND;
      if (value < LOW_EXIT) return LOW_FIELD;
      return FIELD_DETECTED;

    case STRONG_FIELD:
      if (value < BACKGROUND_EXIT) return BACKGROUND;
      if (value < LOW_EXIT) return LOW_FIELD;
      if (value < DETECT_EXIT) return FIELD_DETECTED;
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

  display.setFont(u8g2_font_6x10_tf);
  display.drawStr(2, 9, "WIREMAP DETECTOR");
  display.drawStr(105, 9, "AC");
  display.drawHLine(0, 12, 128);

  display.setFont(u8g2_font_7x14B_tf);

  if (currentState == STRONG_FIELD) {
    display.drawStr(2, 29, "POSSIBLE WIRE");
    display.drawStr(2, 42, "DETECTED!");
  } else {
    display.drawStr(2, 31, getStatusText(currentState));
  }

  drawSignalBar();

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
// BUZZER CONTROL
// ======================================

void updateBuzzer() {
  unsigned long now = millis();

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

  if (!buzzerActive && (lastBeepStart == 0 || now - lastBeepStart >= beepPeriod)) {
    tone(BUZZER_PIN, frequency);
    buzzerActive = true;
    lastBeepStart = now;
  }

  if (buzzerActive && now - lastBeepStart >= beepDuration) {
    noTone(BUZZER_PIN);
    buzzerActive = false;
  }
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
  Serial.print(" mV | STATUS: ");
  Serial.println(getStatusText(currentState));
}

// ======================================
// WEBSITE JSON OUTPUT
// ======================================

String buildJsonPayload(float voltage, const String& status) {
  StaticJsonDocument<128> doc;
  doc["voltage"] = voltage;
  doc["status"]  = status;
  doc["device"]  = "connected";
  String output;
  serializeJson(doc, output);
  return output;
}

void publishToWebsite() {
  float voltageV = filteredRMS / 1000.0;
  lastVoltage = voltageV;
  lastStatus = (voltageV >= 0.02) ? "HIGH" : "LOW";

  String json = buildJsonPayload(lastVoltage, lastStatus);
  wsServer.broadcastTXT(json);
}

// ======================================
// WEB SERVER HANDLERS
// ======================================

void handleData() {
  httpServer.sendHeader("Access-Control-Allow-Origin", "*");
  httpServer.send(200, "application/json", buildJsonPayload(lastVoltage, lastStatus));
}

void handlePing() {
  httpServer.sendHeader("Access-Control-Allow-Origin", "*");
  httpServer.send(200, "text/plain", "pong");
}

void handleRoot() {
  httpServer.sendHeader("Access-Control-Allow-Origin", "*");
  String html = "<html><body><h2>ESP32 Voltage Node</h2>"
                "<p>IP: " + WiFi.localIP().toString() + "</p>"
                "<p>WebSocket port: 81</p>"
                "<p>HTTP JSON: <a href='/data'>/data</a></p>"
                "</body></html>";
  httpServer.send(200, "text/html", html);
}

void onWebSocketEvent(uint8_t clientId, WStype_t type, uint8_t* payload, size_t length) {
  if (type == WStype_CONNECTED) {
    Serial.printf("[WS] Client #%u connected\n", clientId);
    String json = buildJsonPayload(lastVoltage, lastStatus);
    wsServer.sendTXT(clientId, json);
  } else if (type == WStype_DISCONNECTED) {
    Serial.printf("[WS] Client #%u disconnected\n", clientId);
  }
}

// ======================================
// SETUP
// ======================================

void setup() {
  Serial.begin(115200);

  pinMode(BUZZER_PIN, OUTPUT);
  noTone(BUZZER_PIN);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Connecting to Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }

  Serial.println();
  Serial.print("Connected! ESP32 IP address: ");
  Serial.println(WiFi.localIP());
  Serial.println("Use this IP in the website's ESP32 IP field.");

  // Initialize I2C
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(100000);

  // Initialize OLED
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
    Serial.println("ADS1115 not detected! Continuing without sensor data.");
    adsReady = false;
  } else {
    adsReady = true;
    ads.setGain(GAIN_ONE);
    ads.setDataRate(RATE_ADS1115_860SPS);
  }

  // HTTP + WebSocket setup
  httpServer.on("/", handleRoot);
  httpServer.on("/data", handleData);
  httpServer.on("/ping", handlePing);
  httpServer.begin();

  wsServer.begin();
  wsServer.onEvent(onWebSocketEvent);

  Serial.println("HTTP server on port 80, WebSocket server on port 81.");

  display.clearBuffer();
  display.drawStr(0, 25, "SYSTEM READY");
  display.drawStr(0, 42, "Scanning...");
  display.sendBuffer();
  delay(500);
}

// ======================================
// MAIN LOOP
// ======================================

void loop() {
  httpServer.handleClient();
  wsServer.loop();

  readSensor();
  updateDetection();
  updateBuzzer();

  unsigned long now = millis();

  if (now - lastDisplayUpdate >= 500) {
    updateOLED();
    lastDisplayUpdate = now;
  }

  if (now - lastSerialUpdate >= 1000) {
    printSerialData();
    lastSerialUpdate = now;
  }

  if (now - lastPublish >= 200) {
    publishToWebsite();
    lastPublish = now;
  }
}
