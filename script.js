// =====================================================
// Assistive Eye-Gaze Tracker (WebGazer + FaceMesh)
// Eli + Lennard build ❤️
// =====================================================

let model, video, canvas, ctx;
let cursor;
let offCanvas, offCtx;

// --- gaze state ---
let gazeX = 0, gazeY = 0;
let lastGazeTime = 0;              // when webgazer last gave us a point
let smoothX = 0, smoothY = 0;       // smoothed screen coords

// --- blink / mouth ---
let lastClick = 0;
let mouthBaseline = null;
let mouthSamples = [];
let mouthReady = false;

// --- lighting ---
let brightnessFactor = 1;
let contrastFactor = .5;

// ====== tiny beep ======
function playBeep(f = 444, d = 0.15) {
  const a = new (window.AudioContext || window.webkitAudioContext)();
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = "sine";
  o.frequency.value = f;
  g.gain.setValueAtTime(0.2, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + d);
  o.connect(g); g.connect(a.destination);
  o.start(); o.stop(a.currentTime + d);
}

// ====== camera ======
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

// try to keep canvas same size as video
function resize() {
  canvas.width = video.videoWidth || canvas.clientWidth;
  canvas.height = video.videoHeight || canvas.clientHeight;
  offCanvas.width = canvas.width;
  offCanvas.height = canvas.height;
}

// ====== webgazer loader ======
function loadWebGazer() {
  if (window.webgazer) {
    startWebGazer();
    return;
  }
  const s = document.createElement("script");
  s.src = "https://webgazer.cs.brown.edu/webgazer.js";
  s.onload = startWebGazer;
  document.head.appendChild(s);
}

function startWebGazer() {
  console.log("🎯 WebGazer starting…");
  webgazer
    .setRegression("ridge")
    .setTracker("clmtrackr")
    .begin()
    .then(() => {
      webgazer.showVideoPreview(false)
              .showPredictionPoints(false)
              .applyKalmanFilter(true);

      // this fires ~each frame with gaze in *window* coords
      webgazer.setGazeListener((data, ts) => {
        if (!data) return;
        gazeX = data.x;
        gazeY = data.y;
        lastGazeTime = Date.now();
      });

      console.log("✅ WebGazer ready – move your eyes and we should follow.");
    });
}

// ====== brightness helpers ======
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

function adaptLighting(v) {
  if (v < 0.30) {
    brightnessFactor = 1.7;
    contrastFactor = 0.8;
  } else if (v < 0.5) {
    brightnessFactor = 1.5;
    contrastFactor = 0.7;
  } else if (v > 0.8) {
    brightnessFactor = 1.2;
    contrastFactor = 0.6;
  } else {
    brightnessFactor = 1;
    contrastFactor = .5;
  }
}

// ====== mouth gap (like you asked: “use mouth logic on eyes” – we’ll start with mouth solid) ======
function avgGap(mesh, topIdx, botIdx) {
  const n = Math.min(topIdx.length, botIdx.length);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += Math.abs(mesh[topIdx[i]][1] - mesh[botIdx[i]][1]);
  }
  return s / n;
}

// ====== main render ======
async function render() {
  // 1) draw raw frame to offscreen for brightness
  offCtx.filter = "";
  offCtx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);
  const lumin = measureFrameBrightness();
  adaptLighting(lumin);

  // 2) now draw brightened for FaceMesh
  offCtx.filter = `brightness(${brightnessFactor}) contrast(${contrastFactor})`;
  offCtx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);

  // 3) run facemesh
  const faces = await model.estimateFaces(offCanvas);

  // 4) clear overlay
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (faces.length > 0) {
    const face = faces[0];
    const k = face.scaledMesh;

    // draw debug mesh
    ctx.fillStyle = "rgba(0,255,0,0.6)";
    for (const [x, y] of k) {
      ctx.fillRect(x, y, 2, 2);
    }

    // ----- MOUTH CLICK (less touchy) -----
    // lips top cluster + bottom cluster
    const mouthTop = [13, 14, 0, 267].map(i => k[i]); // 13 top lip, 14-ish, and 0/267 corners
    const mouthBot = [17, 18, 87, 317].map(i => k[i]); // 17 lower lip, etc.

    // turn those into index lists for avgGap
    const mouthTopIdx = [13, 14];
    const mouthBotIdx = [17, 18];

    const mouthGap = avgGap(k, mouthTopIdx, mouthBotIdx);

    if (!mouthReady) {
      mouthSamples.push(mouthGap);
      if (mouthSamples.length > 50) {
        mouthBaseline = mouthSamples.reduce((a, b) => a + b, 0) / mouthSamples.length;
        mouthReady = true;
        console.log("👄 mouth baseline:", mouthBaseline.toFixed(3));
      }
    } else {
      // must be clearly bigger than baseline
      const mouthThreshold = mouthBaseline * 1.65; // bump this to make it less touchy
      const mouthOpen = mouthGap > mouthThreshold;

      if (mouthOpen && Date.now() - lastClick > 900) {
        lastClick = Date.now();
        cursor.style.background = "rgba(255,0,0,0.85)";
        playBeep(444, 0.18);
        setTimeout(() => (cursor.style.background = "rgba(0,255,0,0.7)"), 180);
        console.log("✅ mouth click");
      }
    }

    // ----- FALLBACK GAZE (head-based) -----
  // ---------- Fallback gaze from FaceMesh (when WebGazer is stale) ----------

// key points
const nose = k[1];          // nose tip
const leftIrisPts  = k.slice(468, 472);
const rightIrisPts = k.slice(473, 477);

// average iris centers (safer than single index)
const leftIris  = leftIrisPts.reduce((a,p)=>[a[0]+p[0], a[1]+p[1]], [0,0]).map(v=>v/leftIrisPts.length);
const rightIris = rightIrisPts.reduce((a,p)=>[a[0]+p[0], a[1]+p[1]], [0,0]).map(v=>v/rightIrisPts.length);
const irisX = (leftIris[0] + rightIris[0]) / 2;
const irisY = (leftIris[1] + rightIris[1]) / 2;

// normalize by face size so small eye motions matter
const leftFace  = k[234];     // left cheek/temple
const rightFace = k[454];     // right cheek/temple
const topFace   = k[10];
const botFace   = k[152];

const faceW = Math.max(40, rightFace[0] - leftFace[0]);
const faceH = Math.max(50, botFace[1]   - topFace[1]);

// offset of gaze relative to nose, in face-space
let ndx = (irisX - nose[0]) / faceW;   // -0.5 … 0.5 ish
let ndy = (irisY - nose[1]) / faceH;   // -0.5 … 0.5 ish

// scale to canvas space (tweak gains if you want more reach)
const FALLBACK_H_GAIN = 2.2;
const FALLBACK_V_GAIN = 2.0;

let fbX = canvas.width  / 2 - ndx * canvas.width  * FALLBACK_H_GAIN;
let fbY = canvas.height / 2 + ndy * canvas.height * FALLBACK_V_GAIN;

// clamp
fbX = Math.max(0, Math.min(canvas.width,  fbX));
fbY = Math.max(0, Math.min(canvas.height, fbY));


// ---------- Choose gaze source (WebGazer vs fallback) ----------

const now = performance.now();
let targetX, targetY;
const haveWebGazer = (now - lastGazeTime) < 400;   // “fresh” in the last 0.4s

if (haveWebGazer) {
  // webgazer gives WINDOW coords → normalize → map to OUR canvas
  const normX = gazeX / window.innerWidth;   // 0..1
  const normY = gazeY / window.innerHeight;  // 0..1

  // map to canvas and MIRROR X because video is flipped
  targetX = canvas.width  - normX * canvas.width;
  targetY =               normY * canvas.height;
} else {
  // use our facemesh-based gaze, also mirrored
  targetX = canvas.width - fbX;
  targetY = fbY;
}

// ---------- Smooth + apply to DOM cursor ----------
const SMOOTH = 0.25;
smoothX += (targetX - smoothX) * SMOOTH;
smoothY += (targetY - smoothY) * SMOOTH;

cursor.style.left = `${smoothX}px`;
cursor.style.top  = `${smoothY}px`;


    // ----- SMOOTH + DRAW CURSOR -----
    const lerp = haveWebGazer ? 0.25 : 0.15;
    smoothX += (targetX - smoothX) * lerp;
    smoothY += (targetY - smoothY) * lerp;

    // if we're using webgazer, cursor is in window coords
    if (haveWebGazer) {
      cursor.style.left = `${smoothX}px`;
      cursor.style.top = `${smoothY}px`;
    } else {
      // facemesh coords -> overlay
      cursor.style.left = `${smoothX}px`;
      cursor.style.top = `${smoothY}px`;
    }
  }

  requestAnimationFrame(render);
}

// ====== init ======
async function init() {
  cursor = document.getElementById("cursor");
  await setupCamera();

  canvas = document.getElementById("overlay");
  ctx = canvas.getContext("2d");

  offCanvas = document.createElement("canvas");
  offCtx = offCanvas.getContext("2d");

  resize();
  window.addEventListener("resize", resize);

  // load TF facemesh
  model = await facemesh.load();
  console.log("✅ FaceMesh loaded");

  // load webgazer
  loadWebGazer();

  // start loop
  render();
}

init();
