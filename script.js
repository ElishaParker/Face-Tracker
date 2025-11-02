let model, video, canvas, ctx;
let cursor, lastBlink = 0;

async function setupCamera() {
  video = document.getElementById('video');
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;
  await new Promise((resolve) => video.onloadedmetadata = resolve);
}

async function init() {
  cursor = document.getElementById('cursor');

  await setupCamera();

  canvas = document.getElementById('overlay');
  ctx = canvas.getContext('2d');

  resize();
  window.addEventListener('resize', resize);

  // ✅ Fix: Make sure this is defined in version 1.0.1
  model = await faceLandmarksDetection.load(
    faceLandmarksDetection.SupportedPackages.mediapipeFacemesh
  );

  render();
}

function resize() {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
}

async function render() {
  const predictions = await model.estimateFaces({ input: video });

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (predictions.length > 0 && predictions[0].scaledMesh) {
    const keypoints = predictions[0].scaledMesh;

    // ✅ Safety check for keypoint length
    if (keypoints.length < 387) return;

    // Draw facial points
    ctx.fillStyle = 'rgba(0,255,0,0.5)';
    for (let [x, y] of keypoints) {
      ctx.fillRect(x, y, 1.5, 1.5);
    }

    // Eye center between two keypoints
    const leftEye = keypoints[159];
    const rightEye = keypoints[386];
    const dx = (rightEye[0] + leftEye[0]) / 2;
    const dy = (rightEye[1] + leftEye[1]) / 2;

    // Cursor mapping (invert X for mirrored webcam)
    const x = dx;
    const y = dy;
    cursor.style.left = `${x}px`;
    cursor.style.top = `${y}px`;

    // Blink detection — eyelid vertical distance
    const eyeTop = keypoints[159][1];
    const eyeBottom = keypoints[145][1];
    const eyeDist = Math.abs(eyeTop - eyeBottom);

    if (eyeDist < 2 && Date.now() - lastBlink > 500) {
      lastBlink = Date.now();
      cursor.style.background = 'rgba(255,0,0,0.8)';
      setTimeout(() => {
        cursor.style.background = 'rgba(0,255,0,0.6)';
      }, 200);
    }
  }

  requestAnimationFrame(render);
}

init();
