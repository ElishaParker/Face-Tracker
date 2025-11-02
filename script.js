// =====================================================
// Assistive Eye-Gaze Tracker (WebGazer + FaceMesh)
// cleaned + eye-box fallback + correct Y
// =====================================================

let model, video, canvas, ctx;
let cursor;
let offCanvas, offCtx;

// --- gaze state ---
let gazeX = 0, gazeY = 0;
let lastGazeTime = 0;
let smoothX = 0, smoothY = 0;

// --- mouth click ---
let mouthBaseline = null;
let mouthSamples = [];
let mouthReady = false;
let lastClick = 0;

// ===== tiny beep =====
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

// keep canvas in sync
function resize() {
  canvas.width = video.videoWidth || canvas.clientWidth;
  canvas.height = video.videoHeight || canvas.clientHeight;
  offCanvas.width = canvas.width;
  offCanvas.height = canvas.height;
}

// ===== WebGazer =====
function loadWebGazer() {
  if (window.webgazer) { startWebGazer(); return; }
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
      webgazer
        .showVideoPreview(false)
        .showPredictionPoints(false)
        .applyKalmanFilter(true);

      webgazer.setGazeListener((data) => {
        if (!data) return;
        gazeX = data.x;
        gazeY = data.y;
        lastGazeTime = performance.now();
      });

      console.log("✅ WebGazer ready");
    });
}

// ===== helper for mouth gap =====
function gap(mesh, tops, bots) {
  const n = Math.min(tops.length, bots.length);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += Math.abs(mesh[tops[i]][1] - mesh[bots[i]][1]);
  }
  return s / n;
}

// ===== main render =====
async function render() {
  // draw raw frame to offscreen (no brightness tricks now)
  offCtx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);

  // run facemesh on offscreen
  const faces = await model.estimateFaces(offCanvas);

  // clear overlay
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // defaults in case no face
  let targetX = canvas.width / 2;
  let targetY = canvas.height / 2;

  if (faces.length > 0) {
    const face = faces[0];
    const k = face.scaledMesh;

    // debug mesh
    ctx.fillStyle = "rgba(0,255,0,0.6)";
    for (const [x, y] of k) ctx.fillRect(x, y, 2, 2);

    // =========== MOUTH CLICK (less touchy) ===========
    const mouthTopIdx = [13, 14];
    const mouthBotIdx = [17, 18];
    const mGap = gap(k, mouthTopIdx, mouthBotIdx);

    if (!mouthReady) {
      mouthSamples.push(mGap);
      if (mouthSamples.length > 50) {
        mouthBaseline = mouthSamples.reduce((a, b) => a + b, 0) / mouthSamples.length;
        mouthReady = true;
        console.log("👄 mouth baseline:", mouthBaseline.toFixed(3));
      }
    } else {
      const mouthThresh = mouthBaseline * 1.65; // tuned up so it’s not hair-trigger
      const mouthOpen = mGap > mouthThresh;
      if (mouthOpen && performance.now() - lastClick > 850) {
        lastClick = performance.now();
        cursor.style.background = "rgba(255,0,0,0.85)";
        playBeep(444, 0.18);
        setTimeout(() => (cursor.style.background = "rgba(0,255,0,0.7)"), 180);
        console.log("✅ mouth click");
      }
    }

    // =========== EYE-BOX FALLBACK ===========
    // instead of using the whole face, we use just the eye rectangle
    // so SMALL eye moves make BIG cursor moves.

    // eye outer corners
    const leftOuter  = k[33];   // left eye outer corner
    const rightOuter = k[263];  // right eye outer corner

    // upper/lower for vertical reference
    const leftUpper  = k[159];
    const leftLower  = k[145];
    const rightUpper = k[386];
    const rightLower = k[374];

    // iris centers (averaged groups)
    const lIrisPts = k.slice(468, 472);
    const rIrisPts = k.slice(473, 477);
    const leftIris = lIrisPts.reduce((a,p)=>[a[0]+p[0], a[1]+p[1]], [0,0]).map(v=>v/lIrisPts.length);
    const rightIris = rIrisPts.reduce((a,p)=>[a[0]+p[0], a[1]+p[1]], [0,0]).map(v=>v/rIrisPts.length);

    const irisX = (leftIris[0] + rightIris[0]) / 2;
    const irisY = (leftIris[1] + rightIris[1]) / 2;

    // eye center and size
    const eyeCenterX = (leftOuter[0] + rightOuter[0]) / 2;
    const eyeWidth   = Math.max(40, rightOuter[0] - leftOuter[0]); // px
    const eyeMidY    = (leftUpper[1] + leftLower[1] + rightUpper[1] + rightLower[1]) / 4;
    const eyeHeight  = Math.max(14, ((leftLower[1] - leftUpper[1]) + (rightLower[1] - rightUpper[1])) / 2);

    // normalize iris inside the eye box
    // horizontal: -1 (far left) → +1 (far right)
    let normX = (irisX - eyeCenterX) / (eyeWidth / 2);
    // vertical: -1 (look up) → +1 (look down)
    let normY = (irisY - eyeMidY) / (eyeHeight / 2);

    // clamp
    normX = Math.max(-1, Math.min(1, normX));
    normY = Math.max(-1, Math.min(1, normY));

    // map to screen — REMEMBER: video is mirrored, so flip X
    const F_GAIN_X = 0.60;  // lower = less travel, raise for more
    const F_GAIN_Y = 0.70;

    let fbX = canvas.width  / 2 - (normX * canvas.width  * F_GAIN_X);
    // IMPORTANT: you said “when I look up, cursor should go UP”
    let fbY = canvas.height / 2 - (normY * canvas.height * F_GAIN_Y);

    // clamp to canvas
    fbX = Math.max(0, Math.min(canvas.width,  fbX));
    fbY = Math.max(0, Math.min(canvas.height, fbY));

    // =========== PICK GAZE SOURCE ===========
    const now = performance.now();
    const haveWG = (now - lastGazeTime) < 350; // webgazer is recent

    if (haveWG) {
      // webgazer gives WINDOW coords → normalize → map to canvas
      const wx = gazeX / window.innerWidth;
      const wy = gazeY / window.innerHeight;
      // mirror X to match flipped video
      targetX = canvas.width  - wx * canvas.width;
      targetY = wy * canvas.height;
    } else {
      targetX = fbX;
      targetY = fbY;
    }
  }

  // ===== one smoothing pass =====
  const SMOOTH = 0.28;
  smoothX += (targetX - smoothX) * SMOOTH;
  smoothY += (targetY - smoothY) * SMOOTH;

  cursor.style.left = `${smoothX}px`;
  cursor.style.top  = `${smoothY}px`;

  requestAnimationFrame(render);
}

// ===== init =====
async function init() {
  cursor = document.getElementById("cursor");
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

  render();
}

init();
