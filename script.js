// ===============================
// Face Tracker v1.1
// Gaze Direction Cursor + Live Blink Visualization
// ===============================

let model, video, canvas, ctx;
let cursor, lastBlink = 0;
let smoothX = 0, smoothY = 0;

async function setupCamera() {
  video = document.getElementById("video");
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;
  await new Promise(resolve => (video.onloadedmetadata = resolve));
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

async function render() {
  const predictions = await model.estimateFaces(video);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (predictions.length > 0) {
    const face = predictions[0];
    const keypoints = face.scaledMesh;

    // === Draw all face landmarks ===
    ctx.fillStyle = "rgba(0,255,0,0.6)";
    for (const [x, y] of keypoints) ctx.fillRect(x, y, 2, 2);

    // === Eye tracking landmarks ===
    const leftEyeUpper = keypoints[159];
    const leftEyeLower = keypoints[145];
    const rightEyeUpper = keypoints[386];
    const rightEyeLower = keypoints[374];
    const leftIrisCenter = keypoints[468] || leftEyeUpper;
    const rightIrisCenter = keypoints[473] || rightEyeUpper;

    // === Blink detection ===
    const leftBlinkDist = Math.abs(leftEyeUpper[1] - leftEyeLower[1]);
    const rightBlinkDist = Math.abs(rightEyeUpper[1] - rightEyeLower[1]);
    const blink = leftBlinkDist < 2.5 && rightBlinkDist < 2.5;

    // Visual feedback for blink (draw over eyes)
    ctx.fillStyle = blink ? "rgba(255,0,0,0.6)" : "rgba(0,255,0,0.4)";
    ctx.fillRect(leftIrisCenter[0] - 3, leftIrisCenter[1] - 3, 6, 6);
    ctx.fillRect(rightIrisCenter[0] - 3, rightIrisCenter[1] - 3, 6, 6);

    // === Gaze direction estimation ===
    const nose = keypoints[1];
    const avgIrisX = (leftIrisCenter[0] + rightIrisCenter[0]) / 2;
    const avgIrisY = (leftIrisCenter[1] + rightIrisCenter[1]) / 2;

    const dx = (avgIrisX - nose[0]) * 8; // horizontal sensitivity
    const dy = (avgIrisY - nose[1]) * 8; // vertical sensitivity

    const targetX = canvas.width / 2 - dx;
    const targetY = canvas.height / 2 + dy;

    // === Smooth the motion ===
    const smoothing = 0.15;
    smoothX += (targetX - smoothX) * smoothing;
    smoothY += (targetY - smoothY) * smoothing;

    // === Mirror horizontally for natural control ===
    const mirroredX = canvas.width - smoothX;

    // === Move cursor ===
    cursor.style.left = `${mirroredX}px`;
    cursor.style.top = `${smoothY}px`;

    // === Debug line: gaze direction vector ===
    ctx.strokeStyle = "rgba(0,255,255,0.6)";
    ctx.beginPath();
    ctx.moveTo(nose[0], nose[1]);
    ctx.lineTo(avgIrisX, avgIrisY);
    ctx.stroke();

    // === Blink feedback on cursor ===
    if (blink && Date.now() - lastBlink > 500) {
      lastBlink = Date.now();
      cursor.style.background = "rgba(255,0,0,0.8)";
      setTimeout(() => (cursor.style.background = "rgba(0,255,0,0.6)"), 200);
    }
  }

  requestAnimationFrame(render);
}

init();
