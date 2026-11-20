// =====================================================================
// CAMERA MODULE
// Handles live webcam access + test-image upload as an alternative
// source of frames for ArUco tracking.
// =====================================================================

const CameraModule = (() => {
  const video = document.getElementById("video");
  const overlay = document.getElementById("overlay");
  let active = false;
  let usingStaticImage = false;
  let staticImage = null;

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
      video.srcObject = stream;
      usingStaticImage = false;
      await video.play();
      sizeOverlay();
      active = true;
      lastError = null;
      return true;
    } catch (err) {
      console.error("Camera start failed:", err);
      lastError = err;
      active = false;
      return false;
    }
  }

  // Try to trigger camera permission prompt so devices labels become available
  async function requestPermission(){
    try{
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      if (s && s.getTracks) s.getTracks().forEach(t=>t.stop());
      lastError = null;
      return true;
    }catch(err){ lastError = err; console.warn('Permission request failed', err); return false; }
  }

  async function startWithDevice(deviceId){
    try{
      const constraints = { video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: 1280, height: 720 }, audio: false };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      usingStaticImage = false;
      await video.play();
      sizeOverlay();
      active = true; lastError=null; return true;
    }catch(err){
      console.error("Could not access selected camera:", err);
      lastError = err;
      try { const errEl = document.getElementById('cameraError'); if (errEl) errEl.textContent = err.name + ': ' + err.message; } catch(e){}
      active=false; return false; }
  }

  let lastError = null;
  function getLastError(){ return lastError; }

  function stop() {
    try {
      const stream = video.srcObject;
      if (stream && stream.getTracks) {
        stream.getTracks().forEach(t => t.stop());
      }
    } catch (e) {}
    try { video.pause(); } catch (e) {}
    video.srcObject = null;
    active = false;
    usingStaticImage = false;
    staticImage = null;
  }

  function sizeOverlay() {
    const intrinsicW = usingStaticImage ? (staticImage.naturalWidth || staticImage.width) : video.videoWidth;
    const intrinsicH = usingStaticImage ? (staticImage.naturalHeight || staticImage.height) : video.videoHeight;
    if (!intrinsicW || !intrinsicH) return;
    // The canvas bitmap must always have exactly the camera frame's pixel size, so a
    // marker at pixel (x, y) in the frame is drawn at pixel (x, y) on the overlay.
    // Changing width/height clears the canvas, so only do it when the size really changed.
    if (overlay.width !== intrinsicW) overlay.width = intrinsicW;
    if (overlay.height !== intrinsicH) overlay.height = intrinsicH;
    // On-screen size is controlled purely by CSS (100% of the camera box, same
    // object-fit as the video). No fixed pixel size here - it broke fullscreen/resizing.
    overlay.style.width = '';
    overlay.style.height = '';
  }

  function loadTestImage(file) {
    const img = new Image();
    img.onload = () => {
      staticImage = img;
      usingStaticImage = true;
      active = true;
      sizeOverlay();
    };
    img.src = URL.createObjectURL(file);
  }

  // Returns a canvas-compatible source for reading pixel data
  // (either the live <video> or the uploaded static image).
  function getCurrentFrameSource() {
    return usingStaticImage ? staticImage : video;
  }

  function isActive() { return active; }
  function isStatic() { return usingStaticImage; }

  return { start, startWithDevice, stop, loadTestImage, getCurrentFrameSource, isActive, isStatic, sizeOverlay, video, overlay, getLastError, requestPermission };
})();
// Note: stop is added to return object above; reassign to include stop
