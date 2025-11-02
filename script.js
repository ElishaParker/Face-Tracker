// =====================================================
// Assistive Gaze + Mouth-Click Tracker
// v3 – facemesh (for mouth click) + WebGazer (for cursor)
// =====================================================

let model, video, canvas, ctx;
let cursor;
let offCanvas, offCtx;

// --- WebGazer state ---
let gazeX = null, gazeY = null;
let lastGazeTs = 0;
let webgazerReady = false;

// --- mouth detection state ---
let mouthBaseline = null;
let mouthSamples = [];
let mouthReady = false;
let lastClickTs = 0;

// --- smoothing for cursor ---
let smoothX = 0, smoothY = 0;

// --- lighting ---
let brightnessFactor = 1.3;
let contrastFactor = 1.2;

// ===== beep on click =====
function playBeep(freq = 444, dur = 0.14) {
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.18, ac.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
  osc.connect(g); g.connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + dur);
}

// ===== camera =====
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
  await new Promise(r => (video.onloadedmetadata = r));
}

// ===== resize =====
function resize() {
  const w = video.videoWidth || 1280;
  const h = video.videoHeight || 720;
  canvas.width = w;
  canvas.height = h;
  offCanvas.width = w;
  offCanvas.height = h;
}

// ===== measure frame brightness =====
function measureFrameBrightness() {
  const img = offCtx.getImageData(0, 0, offCanvas.width, offCanvas.height);
  const d = img.data;
  let t = 0;
  for (let i = 0; i < d.length; i += 4) {
    t += (d[i] + d[i + 1] + d[i + 2]) / 3;
  }
  return (t / (d.length / 4)) / 255;
}

function adaptLighting(br) {
  if (br < 0.3) {
    brightnessFactor = 1.9;
    contrastFactor = 1.35;
  } else if (br < 0.5) {
    brightnessFactor = 1.5;
    contrastFactor = 1.25;
  } else if (br > 0.85) {
    brightnessFactor = 1.0;
    contrastFactor = 1.0;
  } else {
    brightnessFactor = 1.25;
    contrastFactor = 1.2;
  }
}

// ===== start webgazer =====
function startWebGazer() {
  if (!window.webgazer) return;
  console.log("🎯 WebGazer starting…");
  window.webgazer
    .setRegression("ridge")
    .setTracker("clmtrackr")
    .begin();

  // hide its own UI
  window.webgazer.showPredictionPoints(false);
  window.webgazer.showVideoPreview(false);

  window.webgazer.setGazeListener((data, ts) => {
    if (!data) return;
    // WebGazer gives page coords already
    gazeX = data.x;
    gazeY = data.y;
    lastGazeTs = ts;
    webgazerReady = true;
  });

  console.log("✅ WebGazer ready (needs a few seconds of you looking around)");
}

// if webgazer.js not on page -> load it
function ensureWebGazer() {
  if (window.webgazer) {
    startWebGazer();
  } else {
    const s = document.createElement("script");
    s.src = "https://webgazer.cs.brown.edu/webgazer.js";
    s.onload = () => startWebGazer();
    document.head.appendChild(s);
  }
}

// ===== main init =====
async function init() {
  cursor = document.getElementById("cursor");
  await setupCamera();

  canvas = document.getElementById("overlay");
  ctx = canvas.getContext("2d");
  offCanvas = document.createElement("canvas");
  offCtx = offCanvas.getContext("2d");

  resize();
  window.addEventListener("resize", resize);

  // facemesh
  model = await facemesh.load();
  console.log("✅ FaceMesh loaded");

  // webgazer
  ensureWebGazer();

  requestAnimationFrame(render);
}

// ===== mouth gap (using annotations if present) =====
function getMouthGap(face) {
  if (face.annotations && face.annotations.lipsUpperInner && face.annotations.lipsLowerInner) {
    const up = face.annotations.lipsUpperInner;
    const lo = face.annotations.lipsLowerInner;
    const upY = up.reduce((a, p) => a + p[1], 0) / up.length;
    const loY = lo.reduce((a, p) => a + p[1], 0) / lo.length;
    return loY - upY;
  }
  // fallback to some mesh points
  const mTop = face.scaledMesh[13];  // approx upper lip
  const mBot = face.scaledMesh[14] || face.scaledMesh[17]; // approx lower
  return Math.abs(mBot[1] - mTop[1]);
}

// ===== render loop =====
async function render() {
  // 1) pull video -> offscreen -> measure light -> re-draw with filter
  offCtx.filter = "";
  offCtx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);
  const luminance = measureFrameBrightness();
  adaptLighting(luminance);
  offCtx.filter = `brightness(${brightnessFactor}) contrast(${contrastFactor})`;
  offCtx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);

  // 2) facemesh
  const faces = await model.estimateFaces(offCanvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (faces.length > 0) {
    const face = faces[0];
    const k = face.scaledMesh;

    // draw landmarks
    ctx.fillStyle = "rgba(0,255,0,0.65)";
    for (const [x, y] of k) ctx.fillRect(x, y, 2, 2);

    // ----- MOUTH OPEN CLICK -----
    const mouthGap = getMouthGap(face);

    if (!mouthReady) {
      mouthSamples.push(mouthGap);
      if (mouthSamples.length > 50) {
        mouthBaseline = mouthSamples.reduce((a, b) => a + b, 0) / mouthSamples.length;
        mouthReady = true;
        console.log("🟢 mouth baseline:", mouthBaseline.toFixed(2));
      }
    } else {
      // consider open when 1) clearly bigger than baseline AND 2) bigger than a hard floor
      const MOUTH_EXTRA = 5.5;    // how much bigger than closed
      const HARD_MIN = 11;        // absolute minimum to count
      const isOpen = (mouthGap > mouthBaseline + MOUTH_EXTRA) || (mouthGap > HARD_MIN);
      const now = Date.now();
      if (isOpen && (now - lastClickTs > 900)) {
        lastClickTs = now;
        cursor.style.background = "rgba(255,0,0,0.85)";
        playBeep();
        setTimeout(() => cursor.style.background = "rgba(0,255,0,0.75)", 220);
        console.log("👄 Mouth click", mouthGap.toFixed(2));
      }

      // draw mouth line for debug
      ctx.strokeStyle = "rgba(255,255,0,0.5)";
      ctx.beginPath();
      const lipU = face.annotations?.lipsUpperInner?.[0] || k[13];
      const lipL = face.annotations?.lipsLowerInner?.[0] || k[14];
      ctx.moveTo(lipU[0], lipU[1]);
      ctx.lineTo(lipL[0], lipL[1]);
      ctx.stroke();
    }
  }

  // 3) CURSOR POSITION
  // We want it to move EVEN IF webgazer isn't sure yet.
  const nowTs = performance.now();
  const hasFreshGaze = webgazerReady && (nowTs - lastGazeTs < 400);

  let targetX, targetY;

  if (hasFreshGaze) {
    // webgazer gives page coords → map to our canvas
    const pageW = window.innerWidth;
    const pageH = window.innerHeight;
    const gx = Math.min(Math.max(gazeX, 0), pageW);
    const gy = Math.min(Math.max(gazeY, 0), pageH);

    // map to canvas coords
    const sx = (gx / pageW) * canvas.width;
    const sy = (gy / pageH) * canvas.height;

    targetX = sx;
    targetY = sy;
  } else {
    // fallback – center of face / nose
    if (faces.length > 0) {
      const face = faces[0];
      const k = face.scaledMesh;
      const nose = k[1];
      targetX = canvas.width - nose[0]; // mirror
      targetY = nose[1];
    } else {
      // nothing – keep last
      targetX = smoothX || canvas.width * 0.5;
      targetY = smoothY || canvas.height * 0.5;
    }
  }

  // smoothing + small deadzone so it doesn't jiggle
  const SMOOTH = 0.28;
  const DEAD = 4;
  if (Math.abs(targetX - smoothX) > DEAD) smoothX += (targetX - smoothX) * SMOOTH;
  if (Math.abs(targetY - smoothY) > DEAD) smoothY += (targetY - smoothY) * SMOOTH;

  cursor.style.left = `${smoothX}px`;
  cursor.style.top = `${smoothY}px`;

  requestAnimationFrame(render);
}

// kick it off
init();
