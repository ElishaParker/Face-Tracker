// ===============================
// Face Tracker v1.2
// Dual-Eye Averaged Gaze + Blink Click Feedback
// ===============================

let model, video, canvas, ctx;
let cursor, lastBlink = 0;
let smoothX = 0, smoothY = 0;

// 🔊 Preload blink sound
const clickSound = new Audio(
  "https://cdn.jsdelivr.net/gh/elishaparker/assets/beep.mp3"
);

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
  render();
}

function resize() {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
}

function averagePoints(points) {
  const sum = points.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

async function render() {
  const predictions = await model.estimateFaces(video);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (predictions.length > 0) {
    const face = predictions[0];
    const keypoints = face.scaledMesh;

    // === Draw full mesh landmarks ===
    ctx.fillStyle = "rgba(0,255,0,0.6)";
    for (const [x, y] of keypoints) ctx.fillRect(x, y, 2, 2);

    // === Iris centers ===
    const leftIris = keypoints.slice(468, 472);
    const rightIris = keypoints.slice(473, 477);

    const leftCenter = averagePoints(leftIris);
    const rightCenter = averagePoints(rightIris);

    // Draw blue dots for pupils
    ctx.fillStyle = "rgba(0,150,255,0.9)";
    ctx.beginPath();
    ctx.arc(leftCenter[0], leftCenter[1], 3, 0, 2 * Math.PI);
    ctx.arc(rightCenter[0], rightCenter[1], 3, 0, 2 * Math.PI);
    ctx.fill();

    // === Gaze vector estimation (average of both eyes) ===
    const nose = keypoints[1];
    const avgIrisX = (leftCenter[0] + rightCenter[0]) / 2;
    const avgIrisY = (leftCenter[1] + rightCenter[1]) / 2;

    const dx = (avgIrisX - nose[0]) * 7; // horizontal sensitivity
    const dy = (avgIrisY - nose[1]) * 7; // vertical sensitivity

    const targetX = canvas.width / 2 - dx;
    const targetY = canvas.height / 2 + dy;

    // === Smooth cursor movement ===
    const smoothing = 0.15;
    smoothX += (targetX - smoothX) * smoothing;
    smoothY += (targetY - smoothY) * smoothing;

    // Mirror horizontally for natural control
    const mirroredX = canvas.width - smoothX;

    // === Move cursor ===
    cursor.style.left = `${mirroredX}px`;
    cursor.style.top = `${smoothY}px`;

    // === Debug line from nose to gaze ===
    ctx.strokeStyle = "rgba(0,255,255,0.5)";
    ctx.beginPath();
    ctx.moveTo(nose[0], nose[1]);
    ctx.lineTo(avgIrisX, avgIrisY);
    ctx.stroke();

    // === Blink detection (adaptive to face scale) ===
    const leftEyeTop = keypoints[159];
    const leftEyeBottom = keypoints[145];
    const rightEyeTop = keypoints[386];
    const rightEyeBottom = keypoints[374];

    const leftEyeDist = Math.abs(leftEyeTop[1] - leftEyeBottom[1]);
    const rightEyeDist = Math.abs(rightEyeTop[1] - rightEyeBottom[1]);
    const eyeAvg = (leftEyeDist + rightEyeDist) / 2;

    const faceHeight = Math.abs(keypoints[10][1] - keypoints[152][1]);
    const blinkThreshold = faceHeight * 0.015; // adaptive ratio

    const blink = eyeAvg < blinkThreshold;

    // === Blink feedback and click sound ===
    if (blink && Date.now() - lastBlink > 700) {
      lastBlink = Date.now();
      cursor.style.background = "rgba(255,0,0,0.8)";
      clickSound.currentTime = 0;
      clickSound.play().catch(() => {}); // ignore autoplay errors
      setTimeout(() => (cursor.style.background = "rgba(0,255,0,0.6)"), 250);
    }

    // === Visual eyelid motion overlay ===
    ctx.strokeStyle = "rgba(255,255,0,0.5)";
    ctx.beginPath();
    ctx.moveTo(leftEyeTop[0], leftEyeTop[1]);
    ctx.lineTo(leftEyeBottom[0], leftEyeBottom[1]);
    ctx.moveTo(rightEyeTop[0], rightEyeTop[1]);
    ctx.lineTo(rightEyeBottom[0], rightEyeBottom[1]);
    ctx.stroke();
  }

  requestAnimationFrame(render);
}

init();
