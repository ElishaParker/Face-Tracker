// =====================================================
// Assistive Eye-Gaze Tracker (FaceMesh + WebGazer)
// =====================================================
//
// • FaceMesh (TF.js)  →  blink + mouth-open detection
// • WebGazer          →  moves cursor on the browser window
// • Adaptive brightness
// • 444 Hz beep on activation
//
// This is a DROP-IN update for your last script.
// =====================================================

let model, video, canvas, ctx;
let cursor, lastClick = 0;
let gazeX = null, gazeY = null;     // from webgazer (viewport coords)
let smoothX = window.innerWidth / 2;
let smoothY = window.innerHeight / 2;

let offCanvas, offCtx;
let blinkBaseline = null, blinkSamples = [], blinkReady = false;
let mouthBaseline = null, mouthSamples = [], mouthReady = false;

let brightnessFactor = 1.3;
let contrastFactor = 1.2;

// -----------------------------------------------------
// utilities
// -----------------------------------------------------
function playBeep(f = 444, d = 0.15) {
  const AC = new (window.AudioContext || window.webkitAudioContext)();
  const osc = AC.createOscillator();
  const gain = AC.createGain();
  osc.type = "sine";
  osc.frequency.value = f;
  gain.gain.setValueAtTime(0.2, AC.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, AC.currentTime + d);
  osc.connect(gain);
  gain.connect(AC.destination);
  osc.start();
  osc.stop(AC.currentTime + d);
}

function doClickFeedback() {
  // avoid spam
  if (Date.now() - lastClick < 500) return;
  lastClick = Date.now();
  if (cursor) {
    const old = cursor.style.background;
    cursor.style.background = "rgba(255,0,0,0.85)";
    setTimeout(() => (cursor.style.background = old || "rgba(0,255,0,0.6)"), 220);
  }
  playBeep(444, 0.2);
}

// -----------------------------------------------------
// exposure (best effort)
// -----------------------------------------------------
async function applyExposureCompensation(track) {
  if (!track || !track.getCapabilities) return;
  const caps = track.getCapabilities();
  if (!caps.exposureCompensation) return;
  const mid = (caps.exposureCompensation.min + caps.exposureCompensation.max) / 2;
  try {
    await track.applyConstraints({
      advanced: [
        { exposureMode: "continuous", exposureCompensation: mid }
      ],
    });
    console.log("✅ exposure compensation set:", mid);
  } catch (e) {
    console.warn("⚠️ exposure not supported:", e);
  }
}

// -----------------------------------------------------
// camera
// -----------------------------------------------------
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

// -----------------------------------------------------
// webgazer
// -----------------------------------------------------
function loadWebGazer() {
  // use CDN that works on GH pages
  const s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/npm/webgazer/dist/webgazer.min.js";
  s.async = true;
  s.onload = startWebGazer;
  document.head.appendChild(s);
}

function startWebGazer() {
  console.log("🎯 starting WebGazer...");
  webgazer
    .setRegression("ridge")
    .setTracker("clmtrackr")
    .begin()
    .showVideoPreview(false)
    .showPredictionPoints(false)
    .applyKalmanFilter(true);

  webgazer.setGazeListener((data) => {
    if (!data) return;
    // viewport coords
    gazeX = data.x;
    gazeY = data.y;
  });

  console.log("✅ WebGazer ready.");
}

// -----------------------------------------------------
// brightness helper
// -----------------------------------------------------
function measureFrameBrightness() {
  const frame = offCtx.getImageData(0, 0, offCanvas.width, offCanvas.height);
  const data = frame.data;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    total += (data[i] + data[i + 1] + data[i + 2]) / 3;
  }
  const pixels = data.length / 4;
  return (total / pixels) / 255;
}

function adaptLighting(b) {
  if (b < 0.30) {
    brightnessFactor = 1.85;
    contrastFactor = 1.4;
  } else if (b < 0.5) {
    brightnessFactor = 1.5;
    contrastFactor = 1.25;
  } else if (b > 0.85) {
    brightnessFactor = 1.0;
    contrastFactor = 1.0;
  } else {
    brightnessFactor = 1.2;
    contrastFactor = 1.1;
  }
}

// -----------------------------------------------------
// init
// -----------------------------------------------------
async function init() {
  cursor = document.getElementById("cursor");
  // ensure cursor is fixed so window coords work
  cursor.style.position = "fixed";
  cursor.style.left = "50%";
  cursor.style.top = "50%";
  cursor.style.zIndex = "9999";

  await setupCamera();

  canvas = document.getElementById("overlay");
  ctx = canvas.getContext("2d");

  offCanvas = document.createElement("canvas");
  offCtx = offCanvas.getContext("2d");

  resize();
  window.addEventListener("resize", resize);

  // load facemesh
  model = await facemesh.load();
  console.log("✅ FaceMesh loaded");

  // start webgazer
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

// -----------------------------------------------------
// main loop
// -----------------------------------------------------
async function render() {
  // 1) draw raw frame
  offCtx.filter = "";
  offCtx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);

  // 2) measure brightness, adapt, redraw with filter
  const lum = measureFrameBrightness();
  adaptLighting(lum);
  offCtx.filter = `brightness(${brightnessFactor}) contrast(${contrastFactor})`;
  offCtx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);

  // 3) run facemesh
  const faces = await model.estimateFaces(offCanvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (faces.length > 0) {
    const face = faces[0];
    const k = face.scaledMesh;

    // draw landmarks
    ctx.fillStyle = "rgba(0,255,0,0.6)";
    for (const [x, y] of k) ctx.fillRect(x, y, 2, 2);

    // --- EYE GAP (blink) ---
    const leftTop = [159, 160, 161, 246];
    const leftBot = [145, 144, 153, 154];
    const rightTop = [386, 385, 384, 398];
    const rightBot = [374, 373, 380, 381];

    const eyeGap = (gapRegion(k, leftTop, leftBot) + gapRegion(k, rightTop, rightBot)) / 2;

    // --- MOUTH GAP (mouth open click) ---
    // using central mouth points
    const mouthTopIdx = [13, 82, 312];    // upper lip band
    const mouthBotIdx = [14, 87, 317];    // lower lip band
    const mouthGap = gapRegion(k, mouthTopIdx, mouthBotIdx);

    // calibration
    if (!blinkReady) {
      blinkSamples.push(eyeGap);
      if (blinkSamples.length > 50) {
        blinkBaseline = blinkSamples.reduce((a, b) => a + b, 0) / blinkSamples.length;
        blinkReady = true;
        console.log("Blink baseline:", blinkBaseline.toFixed(3));
      }
    }

    if (!mouthReady) {
      mouthSamples.push(mouthGap);
      if (mouthSamples.length > 50) {
        mouthBaseline = mouthSamples.reduce((a, b) => a + b, 0) / mouthSamples.length;
        mouthReady = true;
        console.log("Mouth baseline:", mouthBaseline.toFixed(3));
      }
    }

    // after calibration → detect
    if (blinkReady) {
      const blinkThreshold = blinkBaseline * 0.65;
      const isBlink = eyeGap < blinkThreshold;
      drawEyeLines(ctx, k);
      if (isBlink) {
        doClickFeedback();
      }
    }

    if (mouthReady) {
      // mouth open when > 1.6x normal relaxed mouth
      const mouthThreshold = mouthBaseline * 1.6;
      if (mouthGap > mouthThreshold) {
        doClickFeedback();
      }
    }
  }

  // 4) move cursor from webgazer
  // if webgazer hasn't given us a coord yet, keep last / center
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  const targetX = gazeX != null ? gazeX : viewW / 2;
  const targetY = gazeY != null ? gazeY : viewH / 2;

  const smoothing = 0.20;
  smoothX += (targetX - smoothX) * smoothing;
  smoothY += (targetY - smoothY) * smoothing;

  // clamp to viewport
  const clampedX = Math.min(Math.max(0, smoothX), viewW - 10);
  const clampedY = Math.min(Math.max(0, smoothY), viewH - 10);

  if (cursor) {
    cursor.style.left = clampedX + "px";
    cursor.style.top = clampedY + "px";
  }

  requestAnimationFrame(render);
}

// helper like your regionGap but kept local
function gapRegion(mesh, topArr, botArr) {
  const n = Math.min(topArr.length, botArr.length);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += Math.abs(mesh[topArr[i]][1] - mesh[botArr[i]][1]);
  }
  return s / n;
}

function drawEyeLines(ctx, k) {
  ctx.strokeStyle = "rgba(255,255,0,0.5)";
  ctx.beginPath();
  ctx.moveTo(k[159][0], k[159][1]);
  ctx.lineTo(k[145][0], k[145][1]);
  ctx.moveTo(k[386][0], k[386][1]);
  ctx.lineTo(k[374][0], k[374][1]);
  ctx.stroke();
}

// -----------------------------------------------------
init().catch(err => console.error(err));
