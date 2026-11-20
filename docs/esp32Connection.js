// =====================================================================
// ESP32 CONNECTION MODULE
// Talks to the ESP32 over WebSocket (preferred) with automatic fallback
// to HTTP polling of /data if the WebSocket can't connect.
// Exposes: ESP32.connect(ip), ESP32.state {voltage, status, connected}
// =====================================================================

const ESP32 = (() => {
  let ws = null;
  let httpPollTimer = null;
  let ip = null;
  const HIGH_THRESHOLD_V = 0.025;

  const state = {
    connected: false,
    voltage: null,
    status: null,      // "HIGH" | "LOW"
  };

  const listeners = [];
  function onUpdate(cb) { listeners.push(cb); }
  function notify() { listeners.forEach(cb => cb(state)); }

  function setConnected(flag) {
    if (state.connected !== flag) {
      state.connected = flag;
      notify();
    }
  }

  function applyPayload(payload) {
    try {
      const data = JSON.parse(payload);
      if (typeof data.voltage === "number") {
        state.voltage = data.voltage;
      } else if (typeof data.rms === "number") {
        state.voltage = data.rms / 1000;
      } else if (typeof data.pp === "number") {
        state.voltage = data.pp / 1000;
      }

      let status = null;
      if (typeof data.status === "string") {
        status = data.status.toUpperCase();
      } else if (typeof data.state === "number") {
        status = data.state >= 2 ? "FIELD DETECTED" : "LOW";
      }

      if (typeof state.voltage === "number") {
        state.status = state.voltage >= HIGH_THRESHOLD_V ? "HIGH" : "LOW";
      } else if (status) {
        state.status = status;
      }
      setConnected(true);
      notify();
    } catch (e) {
      console.warn("Bad JSON from ESP32:", payload);
    }
  }

  function stopHttpPolling() {
    if (httpPollTimer) { clearInterval(httpPollTimer); httpPollTimer = null; }
  }

  function startHttpPolling() {
    stopHttpPolling();

    const pollOnce = async () => {
      if (!ip) return;
      try {
        const res = await fetch(`http://${ip}/data`, { cache: "no-store" });
        if (!res.ok) throw new Error("bad status");
        const text = await res.text();
        applyPayload(text);
      } catch (e) {
        setConnected(false);
      }
    };

    pollOnce();
    httpPollTimer = setInterval(pollOnce, 500);
  }

  function connect(newIp) {
    ip = String(newIp || '').trim();
    if (!ip) return;

    localStorage.setItem('esp32Ip', ip);

    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    stopHttpPolling();
    setConnected(false);

    try {
      ws = new WebSocket(`ws://${ip}:81/`);

      ws.onopen = () => {
        console.log("WebSocket connected to ESP32");
        setConnected(true);
      };
      ws.onmessage = (evt) => applyPayload(evt.data);
      ws.onerror = () => {
        console.warn("WebSocket error — falling back to HTTP polling");
        startHttpPolling();
      };
      ws.onclose = () => {
        setConnected(false);
        startHttpPolling();
      };
    } catch (e) {
      console.warn("WebSocket connect failed, retrying via polling", e);
      startHttpPolling();
    }
  }

  return { connect, onUpdate, state };
})();
