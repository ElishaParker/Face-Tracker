// ===============================================
// ASSISTIVE FACE TRACKER – tuned
// ===============================================

let model, video, canvas, ctx;
let cursor;
let offCanvas, offCtx;

let smoothX = 0, smoothY = 0;
let lastClick = 0;
let mouthBaseline = null;
let mouthSamples = [];
let mouthReady = false;

// ---------- BEEP ----------
function playBeep(freq = 444, dur = 0.15) {
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.25, ac.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
  osc.connect(g); g.connect(ac.destination);
  osc.start(); osc.stop(ac.currentTime + dur);
}

// ---------- CAMERA ----------
async function setupCamera() {
  video = document.getElementById("video");

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width:  { ideal: vw, max: vw },
      height: { ideal: vh, max: vh },
      facingMode: "user"
    }
  });

  video.srcObject = stream;
  await new Promise(r => (video.onloadedmetadata = r));
  resize();
}

// ---------- RESIZE ----------
function resize() {
  if (!canvas || !offCanvas) return;

  const w = video?.videoWidth  || window.innerWidth;
  const h = video?.videoHeight || window.innerHeight;

  canvas.width = w;
  canvas.height = h;

  offCanvas.width = w;
  offCanvas.height = h;

  if (smoothX === 0 && smoothY === 0) {
    smoothX = w / 2;
    smoothY = h / 2;
  }
}
window.addEventListener("resize", resize);

// ---------- MOUTH GAP ----------
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

// ---------- MAIN LOOP ----------
async function render() {
  offCtx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);

  const faces = await model.estimateFaces(offCanvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  let targetX = smoothX;
  let targetY = smoothY;

  if (faces.length > 0) {
    const k = faces[0].scaledMesh;

    // debug mesh
    ctx.fillStyle = "rgba(0,255,0,0.6)";
    for (const [x, y] of k) ctx.fillRect(x, y, 2, 2);

    // ===== MOUTH CLICK =====
    const mouthTopIdx = [13, 14];
    const mouthBotIdx = [17, 18];
    const mouthGap = avgGap(k, mouthTopIdx, mouthBotIdx);

    if (!mouthReady) {
      mouthSamples.push(mouthGap);
      if (mouthSamples.length > 40) {
        mouthBaseline = mouthSamples.reduce((a, b) => a + b, 0) / mouthSamples.length;
        mouthReady = true;
        console.log("👄 mouth baseline:", mouthBaseline.toFixed(3));
      }
    } else {
      const mouthThreshold = mouthBaseline * 1.7;
      if (mouthGap > mouthThreshold && performance.now() - lastClick > 900) {
        lastClick = performance.now();
        cursor.style.background = "rgba(255,0,0,0.9)";
        playBeep(444, 0.15);
        setTimeout(() => (cursor.style.background = "rgba(0,255,0,0.6)"), 180);
      }
    }

    // ===== EYE / NOSE → CURSOR =====
    const nose = k[1];
    const leftIris =
      (k[468] && k[469] && k[470] && k[471])
        ? [
            (k[468][0] + k[469][0] + k[470][0] + k[471][0]) / 4,
            (k[468][1] + k[469][1] + k[470][1] + k[471][1]) / 4
          ]
        : (k[159] ? [k[159][0], k[159][1]] : null);
    const rightIris =
      (k[473] && k[474] && k[475] && k[476])
        ? [
            (k[473][0] + k[474][0] + k[475][0] + k[476][0]) / 4,
            (k[473][1] + k[474][1] + k[475][1] + k[476][1]) / 4
          ]
        : (k[386] ? [k[386][0], k[386][1]] : null);

    if (nose && leftIris && rightIris) {
      const irisX = (leftIris[0] + rightIris[0]) / 2;
      const irisY = (leftIris[1] + rightIris[1]) / 2;

      const leftFace  = k[234] || nose;
      const rightFace = k[454] || nose;
      const topFace   = k[10]  || nose;
      const botFace   = k[152] || nose;

      const faceW = Math.max(40, rightFace[0] - leftFace[0]);
      const faceH = Math.max(50, botFace[1]   - topFace[1]);

      let ndx = (irisX - nose[0]) / faceW;
      let ndy = (irisY - nose[1]) / faceH;

      // ==== YOUR TWEAKS HERE ====
      const H_GAIN    = 5.5;   // ⬅️ stronger left/right
      const V_GAIN    = 5.5;    // ⬅️ stronger up/down
      const V_NEUTRAL = -0.2;   // we’re using Y_OFFSET instead
      const X_OFFSET  = 0;     // if dot is a bit left/right
      const Y_OFFSET  = 0;   // ⬅️ bump neutral UP more

      // left/right – NOT mirrored here
      const rawX = canvas.width / 2 + ndx * canvas.width * H_GAIN + X_OFFSET;

      // look up → dot up
      const rawY = canvas.height / 2 - (ndy - V_NEUTRAL) * canvas.height * V_GAIN - Y_OFFSET;

      targetX = Math.max(0, Math.min(canvas.width,  rawX));
      targetY = Math.max(0, Math.min(canvas.height, rawY));
    }
  } else {
    targetX = canvas.width / 2;
    targetY = canvas.height / 2;
  }

  // smooth
  const SMOOTH = 0.25;
  smoothX += (targetX - smoothX) * SMOOTH;
  smoothY += (targetY - smoothY) * SMOOTH;

  cursor.style.left = `${smoothX}px`;
  cursor.style.top  = `${smoothY}px`;

  requestAnimationFrame(render);
}

// ---------- init ----------
async function init() {
  cursor = document.getElementById("cursor");
  await setupCamera();

  canvas = document.getElementById("overlay");
  ctx = canvas.getContext("2d");

  offCanvas = document.createElement("canvas");
  offCtx = offCanvas.getContext("2d");

  resize();

  model = await facemesh.load();
  console.log("✅ FaceMesh loaded");

  render();
}

init();
