// =====================================================
// Assistive Eye-Gaze Tracker (FaceMesh + WebGazer)
// =====================================================

let model, video, canvas, ctx;
let cursor;
let offCanvas, offCtx;

let lastBlinkOrMouth = 0;

// ---- gaze values (from webgazer, in window space) ----
let gazeWinX = null;
let gazeWinY = null;

// ---- smoothed, canvas-space cursor ----
let smoothX = 0;
let smoothY = 0;

// ---- eye blink baseline ----
let eyeBaseline = null;
let eyeBaselineSamples = [];
let eyeBaselineReady = false;

// ---- mouth baseline ----
let mouthBaseline = null;
let mouthBaselineSamples = [];
let mouthBaselineReady = false;

// ---- lighting adaption ----
let brightnessFactor = 1.25;
let contrastFactor = 1.15;

// =====================================================
// small 444 Hz beep
// =====================================================
function playBeep(f = 444, d = 0.15) {
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = f;
  gain.gain.setValueAtTime(0.25, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + d);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + d);
}

// =====================================================
// camera
// =====================================================
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

// =====================================================
// init
// =====================================================
async function init() {
  cursor = document.getElementById("cursor");
  await setupCamera();

  canvas = document.getElementById("overlay");
  ctx = canvas.getContext("2d");

  offCanvas = document.createElement("canvas");
  offCtx = offCanvas.getContext("2d");

  resize();
  window.addEventListener("resize", resize);

  // load facemesh (the one you were using before)
  model = await facemesh.load();
  console.log("✅ FaceMesh loaded");

  // start webgazer
  loadWebgazer();

  // start loop
  requestAnimationFrame(render);
}

function resize() {
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  canvas.width = w;
  canvas.height = h;
  offCanvas.width = w;
  offCanvas.height = h;
}

// =====================================================
// helper: average of points
// =====================================================
function avg(pts) {
  const s = pts.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
  return [s[0] / pts.length, s[1] / pts.length];
}

// =====================================================
// measure frame brightness and adapt
// =====================================================
function measureBrightness() {
  const img = offCtx.getImageData(0, 0, offCanvas.width, offCanvas.height);
  const data = img.data;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    total += (data[i] + data[i + 1] + data[i + 2]) / 3;
  }
  const pixels = data.length / 4;
  const lum = (total / pixels) / 255;
  return lum;
}

function adaptLighting(lum) {
  if (lum < 0.3) {
    brightnessFactor = 1.8;
    contrastFactor = 1.35;
  } else if (lum < 0.5) {
    brightnessFactor = 1.5;
    contrastFactor = 1.25;
  } else if (lum > 0.85) {
    brightnessFactor = 1.0;
    contrastFactor = 1.0;
  } else {
    brightnessFactor = 1.25;
    contrastFactor = 1.15;
  }
}

// =====================================================
// WEBGAZER
// =====================================================
function loadWebgazer() {
  if (window.webgazer) {
    startWebgazer();
  } else {
    const s = document.createElement("script");
    s.src = "https://webgazer.cs.brown.edu/webgazer.js";
    s.onload = () => startWebgazer();
    document.head.appendChild(s);
  }
}

function startWebgazer() {
  console.log("🎯 starting webgazer…");
  webgazer
    .setRegression("ridge")
    .setTracker("clmtrackr")
    .showVideoPreview(true)     // keep on so you can see its box
    .showPredictionPoints(false)
    .applyKalmanFilter(true)
    .begin();

  // auto-calibrate by feeding a few synthetic points
  // so we’re not stuck at the center
  const w = window.innerWidth;
  const h = window.innerHeight;
  const fakePts = [
    [w * 0.1, h * 0.1],
    [w * 0.9, h * 0.1],
    [w * 0.1, h * 0.9],
    [w * 0.9, h * 0.9],
    [w * 0.5, h * 0.5],
    [w * 0.5, h * 0.1],
    [w * 0.5, h * 0.9],
    [w * 0.1, h * 0.5],
    [w * 0.9, h * 0.5],
  ];
  fakePts.forEach(([x, y]) => {
    // this is how webgazer stores calibration data
    webgazer.recordScreenPosition(x, y, "click");
  });

  webgazer.setGazeListener((data) => {
    if (!data) return;
    gazeWinX = data.x;
    gazeWinY = data.y;
  });

  console.log("✅ webgazer ready (synthetic calibration added)");
}

// =====================================================
// main loop
// =====================================================
async function render() {
  // 1) draw frame → offscreen
  offCtx.filter = "";
  offCtx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);
  const lum = measureBrightness();
  adaptLighting(lum);
  offCtx.filter = `brightness(${brightnessFactor}) contrast(${contrastFactor})`;
  offCtx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);

  // 2) facemesh on *filtered* frame
  const faces = await model.estimateFaces(offCanvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (faces.length > 0) {
    const face = faces[0];
    const k = face.scaledMesh;

    // draw mesh
    ctx.fillStyle = "rgba(0,255,0,0.6)";
    for (const [x, y] of k) ctx.fillRect(x, y, 2, 2);

    // ---------- EYE BLINK BASED ON MULTI POINTS ----------
    const leftTopIdx = [159, 160, 161, 246];
    const leftBotIdx = [145, 144, 153, 154];
    const rightTopIdx = [386, 385, 384, 398];
    const rightBotIdx = [374, 373, 380, 381];

    function gap(mesh, topArr, botArr) {
      const n = Math.min(topArr.length, botArr.length);
      let s = 0;
      for (let i = 0; i < n; i++) {
        s += Math.abs(mesh[topArr[i]][1] - mesh[botArr[i]][1]);
      }
      return s / n;
    }

    const leftGap = gap(k, leftTopIdx, leftBotIdx);
    const rightGap = gap(k, rightTopIdx, rightBotIdx);
    const eyeGap = (leftGap + rightGap) / 2;

    // ---------- MOUTH OPEN USING SAME IDEA ----------
    // 13 = upper lip, 14 = lower lip works well in tfjs facemesh
    const mouthGap = Math.abs(k[13][1] - k[14][1]);

    // collect baselines for first second
    if (!eyeBaselineReady) {
      eyeBaselineSamples.push(eyeGap);
      if (eyeBaselineSamples.length > 60) {
        eyeBaseline =
          eyeBaselineSamples.reduce((a, b) => a + b, 0) /
          eyeBaselineSamples.length;
        eyeBaselineReady = true;
        console.log("👁 eye baseline:", eyeBaseline.toFixed(3));
      }
    }
    if (!mouthBaselineReady) {
      mouthBaselineSamples.push(mouthGap);
      if (mouthBaselineSamples.length > 60) {
        mouthBaseline =
          mouthBaselineSamples.reduce((a, b) => a + b, 0) /
          mouthBaselineSamples.length;
        mouthBaselineReady = true;
        console.log("👄 mouth baseline:", mouthBaseline.toFixed(3));
      }
    }

    // draw eyelid debug lines
    ctx.strokeStyle = "rgba(255,255,0,0.5)";
    ctx.beginPath();
    ctx.moveTo(k[159][0], k[159][1]);
    ctx.lineTo(k[145][0], k[145][1]);
    ctx.moveTo(k[386][0], k[386][1]);
    ctx.lineTo(k[374][0], k[374][1]);
    ctx.stroke();

    // ---------- CLICK LOGIC ----------
    const now = Date.now();
    let fired = false;

    // (A) blink click — more strict
    if (eyeBaselineReady) {
      const blinkThreshold = eyeBaseline * 0.55; // tighter
      const isBlink = eyeGap < blinkThreshold;
      if (isBlink && now - lastBlinkOrMouth > 900) {
        fired = true;
      }
    }

    // (B) mouth click — much bigger than baseline
    if (!fired && mouthBaselineReady) {
      const mouthThreshold = mouthBaseline * 1.8; // must be wide
      const isBigMouth = mouthGap > mouthThreshold;
      if (isBigMouth && now - lastBlinkOrMouth > 900) {
        fired = true;
      }
    }

    if (fired) {
      lastBlinkOrMouth = now;
      cursor.style.background = "rgba(255,0,0,0.85)";
      playBeep(444, 0.2);
      setTimeout(() => {
        cursor.style.background = "rgba(0,255,0,0.6)";
      }, 250);
      console.log("✅ activation");
    }
  }

  // 3) MOVE CURSOR FROM WEBGAZER
  // webgazer gives window coords; we need to map → canvas space
  const cw = canvas.width;
  const ch = canvas.height;
  const ww = window.innerWidth;
  const wh = window.innerHeight;

  // if no prediction yet, keep it centered
  let targetCanvasX = cw / 2;
  let targetCanvasY = ch / 2;

  if (gazeWinX != null && gazeWinY != null) {
    // clamped window coords
    const gx = Math.min(Math.max(gazeWinX, 0), ww);
    const gy = Math.min(Math.max(gazeWinY, 0), wh);

    // map 0..window → 0..canvas
    targetCanvasX = (gx / ww) * cw;
    targetCanvasY = (gy / wh) * ch;
  }

  // smooth
  const smoothing = 0.25;
  smoothX += (targetCanvasX - smoothX) * smoothing;
  smoothY += (targetCanvasY - smoothY) * smoothing;

  // mirror horizontally to match webcam
  const mirroredX = cw - smoothX;

  cursor.style.left = `${mirroredX}px`;
  cursor.style.top = `${smoothY}px`;

  requestAnimationFrame(render);
}

// kick everything off
init();
