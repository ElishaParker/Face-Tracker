// =====================================================
// Assistive Eye-Gaze Tracker (clean, no dim–light filter)
// =====================================================

let model, video, canvas, ctx;
let cursor;
let offCanvas, offCtx;

let smoothX = 0, smoothY = 0;
let lastClick = 0;

// auto-center (assume user looks center at start)
let centerDX = 0, centerDY = 0;
let centerFrames = 0;
const CENTER_FRAMES_NEEDED = 30;

// blink baseline
let eyeBaseline = null;
let eyeBaselineReady = false;
const eyeSamples = [];

// sensitivity
const H_GAIN = 1.8;  // left/right
const V_GAIN = 1.6;  // up/down

// ---- audio click ----
function playBeep(f = 444, d = 0.15) {
  const a = new (window.AudioContext || window.webkitAudioContext)();
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = "sine";
  o.frequency.value = f;
  g.gain.setValueAtTime(0.25, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + d);
  o.connect(g);
  g.connect(a.destination);
  o.start();
  o.stop(a.currentTime + d);
}

// try exposure if supported
async function setupCamera() {
  video = document.getElementById("video");
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: "user",
      advanced: [{ exposureMode: "continuous" }]
    }
  });
  video.srcObject = stream;
  await new Promise(r => (video.onloadedmetadata = r));
}

async function init() {
  cursor = document.getElementById("cursor");
  await setupCamera();

  canvas = document.getElementById("overlay");
  ctx = canvas.getContext("2d");

  offCanvas = document.createElement("canvas");
  offCtx = offCanvas.getContext("2d");

  resize();
  window.addEventListener("resize", resize);

  // tfjs facemesh
  model = await facemesh.load();
  console.log("✅ FaceMesh loaded");

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

// average vertical gap
function regionGap(mesh, topArr, botArr) {
  const n = Math.min(topArr.length, botArr.length);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += Math.abs(mesh[topArr[i]][1] - mesh[botArr[i]][1]);
  }
  return s / n;
}

// simple avg
function avgPoints(arr) {
  let sx = 0, sy = 0;
  for (const p of arr) {
    sx += p[0];
    sy += p[1];
  }
  return [sx / arr.length, sy / arr.length];
}

async function render() {
  // just draw raw video frame
  offCtx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);

  const faces = await model.estimateFaces(offCanvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (faces.length > 0) {
    const f = faces[0];
    const k = f.scaledMesh;

    // draw mesh
    ctx.fillStyle = "rgba(0,255,0,0.6)";
    for (const [x, y] of k) ctx.fillRect(x, y, 2, 2);

    // face size refs
    const leftFace = k[234];
    const rightFace = k[454];
    const topFace = k[10];
    const bottomFace = k[152];
    const nose = k[1];

    const faceW = Math.max(40, rightFace[0] - leftFace[0]);
    const faceH = Math.max(60, bottomFace[1] - topFace[1]);

    // iris centers
    const leftIris = avgPoints(k.slice(468, 472));
    const rightIris = avgPoints(k.slice(473, 477));
    const irisX = (leftIris[0] + rightIris[0]) / 2;
    const irisY = (leftIris[1] + rightIris[1]) / 2;

    // normalized offsets (iris vs nose)
    let dx = (irisX - nose[0]) / faceW;
    let dy = (irisY - nose[1]) / faceH;

    // auto-center first frames
    if (centerFrames < CENTER_FRAMES_NEEDED) {
      centerDX += dx;
      centerDY += dy;
      centerFrames++;
    }
    const cX = centerFrames ? centerDX / centerFrames : 0;
    const cY = centerFrames ? centerDY / centerFrames : 0;

    dx -= cX;
    dy -= cY;

    // map to canvas
    let targetX = canvas.width / 2 - dx * canvas.width * H_GAIN;
    let targetY = canvas.height / 2 + dy * canvas.height * V_GAIN;

    // clamp
    targetX = Math.max(0, Math.min(canvas.width, targetX));
    targetY = Math.max(0, Math.min(canvas.height, targetY));

    // smooth
    smoothX += (targetX - smoothX) * 0.2;
    smoothY += (targetY - smoothY) * 0.2;

    // mirror horizontally
    cursor.style.left = `${canvas.width - smoothX}px`;
    cursor.style.top = `${smoothY}px`;

    // ------------- blink / click -------------
    const leftTop = [159, 160, 161, 246];
    const leftBot = [145, 144, 153, 154];
    const rightTop = [386, 385, 384, 398];
    const rightBot = [374, 373, 380, 381];

    const leftGap = regionGap(k, leftTop, leftBot);
    const rightGap = regionGap(k, rightTop, rightBot);
    const eyeGap = (leftGap + rightGap) / 2;

    // eye lines for debug
    ctx.strokeStyle = "rgba(255,255,0,0.5)";
    ctx.beginPath();
    ctx.moveTo(k[159][0], k[159][1]); ctx.lineTo(k[145][0], k[145][1]);
    ctx.moveTo(k[386][0], k[386][1]); ctx.lineTo(k[374][0], k[374][1]);
    ctx.stroke();

    if (!eyeBaselineReady) {
      eyeSamples.push(eyeGap);
      if (eyeSamples.length > 45) {
        eyeBaseline = eyeSamples.reduce((a, b) => a + b, 0) / eyeSamples.length;
        eyeBaselineReady = true;
        console.log("👁 eye baseline:", eyeBaseline.toFixed(3));
      }
    } else {
      const blinkThresh = eyeBaseline * 0.55; // tighter
      const isBlink = eyeGap < blinkThresh;
      if (isBlink && Date.now() - lastClick > 750) {
        lastClick = Date.now();
        cursor.style.background = "rgba(255,0,0,0.85)";
        playBeep();
        setTimeout(() => {
          cursor.style.background = "rgba(0,255,0,0.6)";
        }, 220);
        console.log("✅ gaze-click");
      }
    }
  }

  requestAnimationFrame(render);
}

init();
