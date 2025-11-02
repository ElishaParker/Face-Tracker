// =====================================================
// Hybrid Eye-Gaze Tracker v2.0
// - WebGazer for smooth gaze-based cursor motion
// - TensorFlow FaceMesh for blink detection + overlay
// =====================================================

let model, video, canvas, ctx;
let cursor, lastBlink = 0;
let gazeX = 0, gazeY = 0; // from WebGazer
let smoothX = 0, smoothY = 0;

// ===== Initialize FaceMesh camera =====
async function setupCamera() {
  video = document.getElementById("video");
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;
  await new Promise(resolve => (video.onloadedmetadata = resolve));
}

// ===== Initialize TensorFlow FaceMesh + WebGazer =====
async function init() {
  cursor = document.getElementById("cursor");
  await setupCamera();

  canvas = document.getElementById("overlay");
  ctx = canvas.getContext("2d");

  resize();
  window.addEventListener("resize", resize);

  // Load FaceMesh
  model = await facemesh.load();
  console.log("✅ FaceMesh model loaded");

  // Load WebGazer
  loadWebGazer();

  render();
}

// ===== Responsive canvas size =====
function resize() {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
}

// ===== Initialize WebGazer (cursor motion only) =====
function loadWebGazer() {
  if (!window.webgazer) {
    const s = document.createElement("script");
    s.src = "https://webgazer.cs.brown.edu/webgazer.js";
    document.head.appendChild(s);
    s.onload = startWebGazer;
  } else startWebGazer();
}

function startWebGazer() {
  console.log("🎯 Initializing WebGazer...");
  webgazer.setRegression("ridge")
          .setTracker("clmtrackr")
          .begin();

  webgazer.showVideoPreview(false)
          .showPredictionPoints(false)
          .applyKalmanFilter(true);

  webgazer.setGazeListener((data) => {
    if (!data) return;
    gazeX = data.x;
    gazeY = data.y;
  });

  console.log("✅ WebGazer active: move your eyes to move the cursor.");
}

// ===== Main Render Loop =====
async function render() {
  const predictions = await model.estimateFaces(video);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // === Face tracking landmarks + blink detection ===
  if (predictions.length > 0) {
    const face = predictions[0];
    const keypoints = face.scaledMesh;

    // Draw landmarks
    ctx.fillStyle = "rgba(0,255,0,0.6)";
    for (const [x, y] of keypoints) ctx.fillRect(x, y, 2, 2);

    // Eye landmarks
    const leftEyeUpper = keypoints[159];
    const leftEyeLower = keypoints[145];
    const rightEyeUpper = keypoints[386];
    const rightEyeLower = keypoints[374];
    const leftIrisCenter = keypoints[468] || leftEyeUpper;
    const rightIrisCenter = keypoints[473] || rightEyeUpper;

    // Blink detection
    const leftBlinkDist = Math.abs(leftEyeUpper[1] - leftEyeLower[1]);
    const rightBlinkDist = Math.abs(rightEyeUpper[1] - rightEyeLower[1]);
    const blink = leftBlinkDist < 2.5 && rightBlinkDist < 2.5;

    // Blink feedback overlay
    ctx.fillStyle = blink ? "rgba(255,0,0,0.6)" : "rgba(0,255,0,0.4)";
    ctx.fillRect(leftIrisCenter[0] - 3, leftIrisCenter[1] - 3, 6, 6);
    ctx.fillRect(rightIrisCenter[0] - 3, rightIrisCenter[1] - 3, 6, 6);

    // Visual blink on cursor
    if (blink && Date.now() - lastBlink > 500) {
      lastBlink = Date.now();
      cursor.style.background = "rgba(255,0,0,0.8)";
      setTimeout(() => (cursor.style.background = "rgba(0,255,0,0.6)"), 200);
      console.log("👁 Blink detected");
    }
  }

  // === Cursor position (WebGazer gaze) ===
  const smoothing = 0.2;
  smoothX += (gazeX - smoothX) * smoothing;
  smoothY += (gazeY - smoothY) * smoothing;

  cursor.style.left = `${smoothX}px`;
  cursor.style.top = `${smoothY}px`;

  requestAnimationFrame(render);
}

init();
