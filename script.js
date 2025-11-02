// ===============================
// Face Tracker v1.3α
// Adaptive Blink Calibration + 444 Hz Tone
// ===============================

let model, video, canvas, ctx;
let cursor, lastBlink = 0;
let smoothX = 0, smoothY = 0;
let blinkBaseline = null;
let baselineSamples = [];
let baselineReady = false;

// === Internal synth (444 Hz) ===
function playBeep(frequency = 444, duration = 0.15) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0.2, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + duration);
}

async function setupCamera() {
  video = document.getElementById("video");
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;
  await new Promise(r => (video.onloadedmetadata = r));
}

async function init() {
  cursor = document.getElementById("cursor");
  await setupCamera();

  canvas = document.getElementById("overlay");
  ctx = canvas.getContext("2d");
  resize();
  window.addEventListener("resize", resize);

  model = await facemesh.load();
  console.log("Model loaded ✅");
  render();
}

function resize() {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
}

function avg(points) {
  const s = points.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
  return [s[0] / points.length, s[1] / points.length];
}

async function render() {
  const faces = await model.estimateFaces(video);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (faces.length > 0) {
    const f = faces[0];
    const k = f.scaledMesh;

    // === Draw mesh ===
    ctx.fillStyle = "rgba(0,255,0,0.6)";
    for (const [x, y] of k) ctx.fillRect(x, y, 2, 2);

    // === Iris tracking ===
    const lIris = k.slice(468, 472);
    const rIris = k.slice(473, 477);
    const lC = avg(lIris);
    const rC = avg(rIris);

    ctx.fillStyle = "rgba(0,150,255,0.9)";
    ctx.beginPath();
    ctx.arc(lC[0], lC[1], 3, 0, 2 * Math.PI);
    ctx.arc(rC[0], rC[1], 3, 0, 2 * Math.PI);
    ctx.fill();

    // === Cursor motion ===
    const nose = k[1];
    const dx = ((lC[0] + rC[0]) / 2 - nose[0]) * 7;
    const dy = ((lC[1] + rC[1]) / 2 - nose[1]) * 7;
    const targetX = canvas.width / 2 - dx;
    const targetY = canvas.height / 2 + dy;
    const s = 0.15;
    smoothX += (targetX - smoothX) * s;
    smoothY += (targetY - smoothY) * s;
    cursor.style.left = `${canvas.width - smoothX}px`;
    cursor.style.top = `${smoothY}px`;

    // === Eye distances ===
    const L = Math.abs(k[159][1] - k[145][1]);
    const R = Math.abs(k[386][1] - k[374][1]);
    const eyeAvg = (L + R) / 2;

    // === Calibrate baseline (first 2 s) ===
    if (!baselineReady) {
      baselineSamples.push(eyeAvg);
      if (baselineSamples.length > 60) {
        blinkBaseline = baselineSamples.reduce((a, b) => a + b, 0) / baselineSamples.length;
        baselineReady = true;
        console.log(`Blink baseline set: ${blinkBaseline.toFixed(2)}`);
      }
    } else {
      const blinkThreshold = blinkBaseline * 0.55; // ~45% closure
      const blink = eyeAvg < blinkThreshold;

      // Visual eyelid line
      ctx.strokeStyle = "rgba(255,255,0,0.5)";
      ctx.beginPath();
      ctx.moveTo(k[159][0], k[159][1]);
      ctx.lineTo(k[145][0], k[145][1]);
      ctx.moveTo(k[386][0], k[386][1]);
      ctx.lineTo(k[374][0], k[374][1]);
      ctx.stroke();

      // === Trigger blink click ===
      if (blink && Date.now() - lastBlink > 600) {
        lastBlink = Date.now();
        cursor.style.background = "rgba(255,0,0,0.8)";
        playBeep(444, 0.2);
        setTimeout(() => (cursor.style.background = "rgba(0,255,0,0.6)"), 250);
      }
    }
  }
  requestAnimationFrame(render);
}

init();
