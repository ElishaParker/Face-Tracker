// =====================================================
// Assistive Eye-Gaze Tracker
// - WebGazer moves the on-screen cursor
// - FaceMesh does mouth/blink → click
// - Fallback to FaceMesh gaze if WebGazer not giving data
// =====================================================

let model, video, canvas, ctx;
let cursor;
let lastClick = 0;

// webgazer gaze (page coords)
let gazeX = null, gazeY = null;
// smoothed cursor
let smoothX = window.innerWidth / 2;
let smoothY = window.innerHeight / 2;

// for brightness
let offCanvas, offCtx;
let brightnessFactor = 1.3;
let contrastFactor = 1.2;

// blink / mouth
let blinkBaseline = null, blinkSamples = [], blinkReady = false;
let mouthBaseline = null, mouthSamples = [], mouthReady = false;
let mouthOpenFrames = 0;

// last face landmarks (so fallback gaze can use them if webgazer is null)
let lastFaceKeypoints = null;

// -------------------- sound --------------------
function playBeep(f = 444, d = 0.15) {
  const AC = new (window.AudioContext || window.webkitAudioContext)();
  const o = AC.createOscillator();
  const g = AC.createGain();
  o.type = "sine";
  o.frequency.value = f;
  g.gain.setValueAtTime(0.2, AC.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, AC.currentTime + d);
  o.connect(g); g.connect(AC.destination);
  o.start(); o.stop(AC.currentTime + d);
}

function doClickFeedback() {
  // global cooldown
  if (Date.now() - lastClick < 700) return;
  lastClick = Date.now();
  if (cursor) {
    const old = cursor.style.background;
    cursor.style.background = "rgba(255,0,0,0.85)";
    setTimeout(() => (cursor.style.background = old || "rgba(0,255,0,0.6)"), 220);
  }
  playBeep(444, 0.2);
}

// -------------------- camera --------------------
async function applyExposureCompensation(track) {
  if (!track || !track.getCapabilities) return;
  const caps = track.getCapabilities();
  if (!caps.exposureCompensation) return;
  const mid = (caps.exposureCompensation.min + caps.exposureCompensation.max) / 2;
  try {
    await track.applyConstraints({
      advanced: [{ exposureMode: "continuous", exposureCompensation: mid }]
    });
  } catch (e) {
    console.warn("exposure not supported", e);
  }
}

async function setupCamera() {
  video = document.getElementById("video");
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: "user"
    }
  });
  video.srcObject = stream;
  const track = stream.getVideoTracks()[0];
  applyExposureCompensation(track).catch(() => {});
  await new Promise(r => (video.onloadedmetadata = r));
}

// -------------------- webgazer --------------------
function loadWebGazer() {
  const s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/npm/webgazer/dist/webgazer.min.js";
  s.async = true;
  s.onload = startWebGazer;
  document.head.appendChild(s);
}

function startWebGazer() {
  console.log("🎯 WebGazer starting...");
  webgazer
    .setRegression("ridge")
    .setTracker("clmtrackr")
    .begin()
    .showVideoPreview(true)   // keep ON so you see it’s working
    .showPredictionPoints(false)
    .applyKalmanFilter(true);

  // main listener
  webgazer.setGazeListener((data) => {
    if (!data) return;
    gazeX = data.x;
    gazeY = data.y;
  });

  // 👇 fake a tiny calibration so it outputs *something*
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  for (let i = 0; i < 10; i++) {
    webgazer.recordScreenPosition(cx, cy, 'click');
  }

  // and also poll just in case the listener is quiet
  setInterval(async () => {
    if (!window.webgazer) return;
    const d = await webgazer.getCurrentPrediction();
    if (d) {
      gazeX = d.x;
      gazeY = d.y;
    }
  }, 120);
}

// -------------------- utils --------------------
function measureFrameBrightness() {
  const frame = offCtx.getImageData(0, 0, offCanvas.width, offCanvas.height);
  const data = frame.data;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    total += (data[i] + data[i + 1] + data[i + 2]) / 3;
  }
  const px = data.length / 4;
  return (total / px) / 255;
}

function adaptLighting(b) {
  if (b < 0.30) { brightnessFactor = 1.85; contrastFactor = 1.4; }
  else if (b < 0.5) { brightnessFactor = 1.5; contrastFactor = 1.25; }
  else if (b > 0.85) { brightnessFactor = 1.0; contrastFactor = 1.0; }
  else { brightnessFactor = 1.2; contrastFactor = 1.1; }
}

function gapRegion(mesh, topArr, botArr) {
  const n = Math.min(topArr.length, botArr.length);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += Math.abs(mesh[topArr[i]][1] - mesh[botArr[i]][1]);
  }
  return s / n;
}

// -------------------- main --------------------
async function init() {
  cursor = document.getElementById("cursor");
  cursor.style.position = "fixed";
  cursor.style.zIndex = "9999";
  cursor.style.left = "50%";
  cursor.style.top = "50%";

  await setupCamera();

  canvas = document.getElementById("overlay");
  ctx = canvas.getContext("2d");
  offCanvas = document.createElement("canvas");
  offCtx = offCanvas.getContext("2d");
  resize();
  window.addEventListener("resize", resize);

  model = await facemesh.load();
  console.log("✅ FaceMesh loaded");

  loadWebGazer();

  requestAnimationFrame(render);
}

function resize() {
  const w = video.videoWidth || 1280;
  const h = video.videoHeight || 720;
  canvas.width = w;
  canvas.height = h;
  offCanvas.width = w;
  offCanvas.height = h;
}

function fallbackGazeFromFace(k) {
  // simple iris+nose fallback
  const nose = k[1];
  const leftIris = k[468] || k[159];
  const rightIris = k[473] || k[386];
  const irisX = (leftIris[0] + rightIris[0]) / 2;
  const irisY = (leftIris[1] + rightIris[1]) / 2;

  // map face-space to screen-space *crudely*
  const dx = (irisX - nose[0]) * 6;
  const dy = (irisY - nose[1]) * 6;
  const tx = window.innerWidth / 2 - dx;
  const ty = window.innerHeight / 2 + dy;
  return { x: tx, y: ty };
}

async function render() {
  // draw video → offscreen
  offCtx.filter = "";
  offCtx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);
  const lum = measureFrameBrightness();
  adaptLighting(lum);
  offCtx.filter = `brightness(${brightnessFactor}) contrast(${contrastFactor})`;
  offCtx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);

  // run facemesh
  const faces = await model.estimateFaces(offCanvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (faces.length > 0) {
    const face = faces[0];
    const k = face.scaledMesh;
    lastFaceKeypoints = k;

    // draw mesh for debug
    ctx.fillStyle = "rgba(0,255,0,0.6)";
    for (const [x, y] of k) ctx.fillRect(x, y, 2, 2);

    // ---- blink
    const leftTop = [159, 160, 161, 246];
    const leftBot = [145, 144, 153, 154];
    const rightTop = [386, 385, 384, 398];
    const rightBot = [374, 373, 380, 381];
    const eyeGap = (gapRegion(k, leftTop, leftBot) + gapRegion(k, rightTop, rightBot)) / 2;

    if (!blinkReady) {
      blinkSamples.push(eyeGap);
      if (blinkSamples.length > 50) {
        blinkBaseline = blinkSamples.reduce((a, b) => a + b, 0) / blinkSamples.length;
        blinkReady = true;
        console.log("Blink baseline:", blinkBaseline.toFixed(3));
      }
    } else {
      const blinkThreshold = blinkBaseline * 0.65;
      const isBlink = eyeGap < blinkThreshold;
      // visualize
      ctx.strokeStyle = "rgba(255,255,0,0.5)";
      ctx.beginPath();
      ctx.moveTo(k[159][0], k[159][1]); ctx.lineTo(k[145][0], k[145][1]);
      ctx.moveTo(k[386][0], k[386][1]); ctx.lineTo(k[374][0], k[374][1]);
      ctx.stroke();
      if (isBlink) {
        doClickFeedback();
      }
    }

    // ---- mouth (debounced)
    const mouthTop = [13, 82, 312];
    const mouthBot = [14, 87, 317];
    const mouthGap = gapRegion(k, mouthTop, mouthBot);

    if (!mouthReady) {
      mouthSamples.push(mouthGap);
      if (mouthSamples.length > 50) {
        mouthBaseline = mouthSamples.reduce((a, b) => a + b, 0) / mouthSamples.length;
        mouthReady = true;
        console.log("Mouth baseline:", mouthBaseline.toFixed(3));
      }
    } else {
      const mouthThreshold = mouthBaseline * 1.9; // harder to fire
      if (mouthGap > mouthThreshold) {
        mouthOpenFrames++;
      } else {
        mouthOpenFrames = 0;
      }
      if (mouthOpenFrames >= 3) { // need 3 frames open
        doClickFeedback();
        mouthOpenFrames = 0;
      }
    }
  }

  // -------- cursor movement --------
  let targetX, targetY;

  if (gazeX != null && gazeY != null) {
    // WebGazer is giving us browser-coords
    targetX = gazeX;
    targetY = gazeY;
  } else if (lastFaceKeypoints) {
    // fallback to FaceMesh gaze
    const fb = fallbackGazeFromFace(lastFaceKeypoints);
    targetX = fb.x;
    targetY = fb.y;
  } else {
    // nothing yet
    targetX = window.innerWidth / 2;
    targetY = window.innerHeight / 2;
  }

  const smoothing = 0.2;
  smoothX += (targetX - smoothX) * smoothing;
  smoothY += (targetY - smoothY) * smoothing;

  const clampedX = Math.min(Math.max(0, smoothX), window.innerWidth - 12);
  const clampedY = Math.min(Math.max(0, smoothY), window.innerHeight - 12);

  cursor.style.left = clampedX + "px";
  cursor.style.top = clampedY + "px";

  requestAnimationFrame(render);
}

init().catch(console.error);
