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
let brightnessFactor = 1.3;
let contrastFactor = 1.2;

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
    brightnessFactor = 1.8;
    contrastFactor = 1.4;
  } else if (v < 0.5) {
    brightnessFactor = 1.5;
    contrastFactor = 1.3;
  } else if (v > 0.8) {
    brightnessFactor = 1.0;
    contrastFactor = 1.0;
  } else {
    brightnessFactor = 1.2;
    contrastFactor = 1.2;
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
    // this is ONLY used when webgazer hasn’t given a point recently
    const nose = k[1];
    const leftIris = k[468] || k[159];
    const rightIris = k[473] || k[386];
    const irisX = (leftIris[0] + rightIris[0]) / 2;
    const irisY = (leftIris[1] + rightIris[1]) / 2;
    const dx = (irisX - nose[0]) * 8;
    const dy = (irisY - nose[1]) * 8;
    const fallbackX = canvas.width / 2 - dx;
    const fallbackY = canvas.height / 2 + dy;

    // ----- CHOOSE GAZE SOURCE -----
    const now = Date.now();
    let targetX, targetY;
    const haveWebGazer = (now - lastGazeTime) < 500; // half a second freshness

    if (haveWebGazer) {
      // webgazer gives WINDOW coords – cap them so cursor stays on video
      targetX = Math.min(Math.max(gazeX, 0), window.innerWidth);
      targetY = Math.min(Math.max(gazeY, 0), window.innerHeight);
    } else {
      targetX = fallbackX;
      targetY = fallbackY;
    }

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
