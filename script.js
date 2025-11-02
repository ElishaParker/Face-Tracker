// =====================================================
// Assistive Eye-Gaze Tracker (nose-anchored, no WG preview)
// =====================================================

let model, video, canvas, ctx;
let cursor;
let offCanvas, offCtx;

let gazeX = 0, gazeY = 0;
let lastGazeTime = 0;          // ms
let smoothX = 120, smoothY = 120;

// mouth / click
let lastClick = 0;
let mouthBaseline = null;
let mouthSamples = [];
let mouthReady = false;

// -----------------------------------------------------
// tiny 444 Hz blip
function playBeep(freq = 444, dur = 0.15) {
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.25, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
  osc.connect(gain); gain.connect(ac.destination);
  osc.start(); osc.stop(ac.currentTime + dur);
}

// -----------------------------------------------------
// camera
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
  await new Promise(r => video.onloadedmetadata = r);
}

// -----------------------------------------------------
// resize canvases to video
function resize() {
  if (!video) return;
  const w = video.videoWidth  || video.clientWidth  || window.innerWidth;
  const h = video.videoHeight || video.clientHeight || window.innerHeight;

  canvas.width  = w;
  canvas.height = h;

  offCanvas.width  = w;
  offCanvas.height = h;

  // when we FIRST know the real size, drop the cursor in the middle
  if (smoothX === 120 && smoothY === 120) {
    smoothX = w / 2;
    smoothY = h / 2;
  }
}

// -----------------------------------------------------
// HARD HIDE webgazer’s own DOM stuff
function killWebgazerUI() {
  const ids = [
    "webgazerVideoContainer",
    "webgazerVideoFeed",
    "webgazerFaceOverlay",
    "webgazerFaceFeedbackBox",
    "webgazerGazeDot"
  ];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.style.display = "none";
      el.remove(); // just nuke it
    }
  });
}

// -----------------------------------------------------
// load webgazer
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
  // NOTE: don't call .setTracker("clmtrackr") – your build only has TFFacemesh
  webgazer
    // .setTracker("TFFacemesh") // optional – we can also let it pick
    .setRegression("ridge")
    .begin()
    .then(() => {
      webgazer
        .showVideoPreview(false)     // try not to show
        .showPredictionPoints(false) // try not to show
        .applyKalmanFilter(true);

      // in case WG re-creates the elements later:
      setTimeout(killWebgazerUI, 500);
      setTimeout(killWebgazerUI, 2000);

      webgazer.setGazeListener((data) => {
        if (!data) return;
        // basic sanity check: viewport
        if (data.x >= 0 && data.x <= window.innerWidth &&
            data.y >= 0 && data.y <= window.innerHeight) {
          gazeX = data.x;
          gazeY = data.y;
          lastGazeTime = performance.now();
        }
      });

      console.log("✅ WebGazer ready.");
    });
}

// -----------------------------------------------------
// compute average distance between two sets of points
function avgGap(mesh, topIdx, botIdx) {
  const n = Math.min(topIdx.length, botIdx.length);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const t = mesh[topIdx[i]];
    const b = mesh[botIdx[i]];
    if (!t || !b) continue;
    s += Math.abs(t[1] - b[1]);
  }
  return s / n;
}

// -----------------------------------------------------
// main render loop
async function render() {
  // draw current frame to offscreen
  offCtx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);

  // run facemesh on that
  const faces = await model.estimateFaces(offCanvas);

  // clear overlay
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  let targetX = smoothX;
  let targetY = smoothY;

  if (faces.length > 0) {
    const k = faces[0].scaledMesh;

    // debug points
    ctx.fillStyle = "rgba(0,255,0,0.6)";
    for (const [x, y] of k) {
      ctx.fillRect(x, y, 2, 2);
    }

    // ========== MOUTH CLICK ==========
    const mouthTopIdx = [13, 14];
    const mouthBotIdx = [17, 18];
    const mouthGap = avgGap(k, mouthTopIdx, mouthBotIdx);

    if (!mouthReady) {
      mouthSamples.push(mouthGap);
      if (mouthSamples.length > 40) {
        mouthBaseline = mouthSamples.reduce((a,b)=>a+b,0) / mouthSamples.length;
        mouthReady = true;
        console.log("👄 mouth baseline:", mouthBaseline.toFixed(3));
      }
    } else {
      const mouthThreshold = mouthBaseline * 1.7;
      const mouthOpen = mouthGap > mouthThreshold;
      if (mouthOpen && (performance.now() - lastClick) > 900) {
        lastClick = performance.now();
        cursor.style.background = "rgba(255,0,0,0.85)";
        playBeep(444, 0.18);
        setTimeout(() => cursor.style.background = "rgba(0,255,0,0.7)", 180);
      }
    }

    // ========== FACEMESH FALLBACK GAZE ==========
    const nose = k[1];
    const leftIris = (k[468] && k[469] && k[470] && k[471])
      ? [
          (k[468][0] + k[469][0] + k[470][0] + k[471][0]) / 4,
          (k[468][1] + k[469][1] + k[470][1] + k[471][1]) / 4
        ]
      : (k[159] ? [k[159][0], k[159][1]] : null);
    const rightIris = (k[473] && k[474] && k[475] && k[476])
      ? [
          (k[473][0] + k[474][0] + k[475][0] + k[476][0]) / 4,
          (k[473][1] + k[474][1] + k[475][1] + k[476][1]) / 4
        ]
      : (k[386] ? [k[386][0], k[386][1]] : null);

    let fbX = canvas.width / 2;
    let fbY = canvas.height / 2;

    if (nose && leftIris && rightIris) {
      const irisX = (leftIris[0] + rightIris[0]) / 2;
      const irisY = (leftIris[1] + rightIris[1]) / 2;

      const leftFace  = k[234] || nose;
      const rightFace = k[454] || nose;
      const topFace   = k[10]  || nose;
      const botFace   = k[152] || nose;

      const faceW = Math.max(40, (rightFace[0] - leftFace[0]));
      const faceH = Math.max(50, (botFace[1]   - topFace[1]));

      let ndx = (irisX - nose[0]) / faceW;
      let ndy = (irisY - nose[1]) / faceH;

      const H_GAIN = 2.2;
      const V_GAIN = 2.0;

      fbX = canvas.width  / 2 - ndx * canvas.width  * H_GAIN;
      fbY = canvas.height / 2 + ndy * canvas.height * V_GAIN;

      fbX = Math.max(0, Math.min(canvas.width,  fbX));
      fbY = Math.max(0, Math.min(canvas.height, fbY));
    }

    // ========== PICK SOURCE ==========
    const now = performance.now();
    const webgazerFresh = (now - lastGazeTime) < 350;

    if (webgazerFresh) {
      const normX = gazeX / window.innerWidth;
      const normY = gazeY / window.innerHeight;
      targetX = canvas.width  - normX * canvas.width;  // mirror
      targetY =               normY * canvas.height;
    } else {
      // our own facemesh gaze, also mirrored
      targetX = canvas.width - fbX;
      targetY = fbY;
    }
  } else {
    // no face → center
    targetX = canvas.width / 2;
    targetY = canvas.height / 2;
  }

  // ========== SMOOTH ==========
  const SMOOTH = 0.25;
  smoothX += (targetX - smoothX) * SMOOTH;
  smoothY += (targetY - smoothY) * SMOOTH;

  cursor.style.left = `${smoothX}px`;
  cursor.style.top  = `${smoothY}px`;

  requestAnimationFrame(render);
}

// -----------------------------------------------------
// init
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
