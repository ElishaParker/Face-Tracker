let model, video, canvas, ctx;
let cursor, lastBlink = 0;

async function setupCamera() {
  video = document.getElementById('video');
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;
  await new Promise(resolve => (video.onloadedmetadata = resolve));
}

async function init() {
  cursor = document.getElementById('cursor');
  await setupCamera();

  canvas = document.getElementById('overlay');
  ctx = canvas.getContext('2d');

  resize();
  window.addEventListener('resize', resize);

  // ✅ Load TensorFlow facemesh model
  model = await facemesh.load();
  render();
}

function resize() {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
}

async function render() {
  try {
    const predictions = await model.estimateFaces(video);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (predictions.length === 0) {
      requestAnimationFrame(render);
      return;
    }

    const face = predictions[0];
    const keypoints = face.scaledMesh;

    // 🟢 Draw mesh landmarks (optional visual guide)
    ctx.fillStyle = 'rgba(0,255,0,0.5)';
    for (const [x, y] of keypoints) ctx.fillRect(x, y, 2, 2);

    // 🧠 Dual-eye gaze estimation (mirror mode, stable)
    if (
      face.annotations?.leftEyeUpper0 &&
      face.annotations?.leftEyeLower0 &&
      face.annotations?.rightEyeUpper0 &&
      face.annotations?.rightEyeLower0
    ) {
      const le = face.annotations.leftEye;
      const re = face.annotations.rightEye;

      // Outer/inner corners
      const leOuter = le?.[0], leInner = le?.[3];
      const reOuter = re?.[3], reInner = re?.[0];

      // Bail safely if missing data
      if (!leOuter || !leInner || !reOuter || !reInner) throw new Error("Missing eye corners");

      // Vertical midpoints
      const leUpper = face.annotations.leftEyeUpper0?.[3];
      const leLower = face.annotations.leftEyeLower0?.[3];
      const reUpper = face.annotations.rightEyeUpper0?.[3];
      const reLower = face.annotations.rightEyeLower0?.[3];
      if (!leUpper || !leLower || !reUpper || !reLower) throw new Error("Missing eyelid points");

      // Centers of each eye
      const leCenter = [
        (leOuter[0] + leInner[0]) / 2,
        (leUpper[1] + leLower[1]) / 2
      ];
      const reCenter = [
        (reOuter[0] + reInner[0]) / 2,
        (reUpper[1] + reLower[1]) / 2
      ];

      // Average both eyes
      const eyeCenterX = (leCenter[0] + reCenter[0]) / 2;
      const eyeCenterY = (leCenter[1] + reCenter[1]) / 2;

      // Normalize offsets
      const eyeWidth =
        (Math.abs(leOuter[0] - leInner[0]) + Math.abs(reOuter[0] - reInner[0])) / 2;
      const eyeHeight =
        (Math.abs(leUpper[1] - leLower[1]) + Math.abs(reUpper[1] - reLower[1])) / 2;

      if (eyeWidth === 0 || eyeHeight === 0) throw new Error("Invalid eye geometry");

      const offsetX =
        (eyeCenterX - ((leInner[0] + reInner[0]) / 2)) / eyeWidth;
      const offsetY =
        (eyeCenterY - ((leUpper[1] + reUpper[1]) / 2)) / eyeHeight;

      // Map to screen space
      const gazeX = canvas.width / 2 - offsetX * canvas.width * 1.2;
      const gazeY = canvas.height / 2 + offsetY * canvas.height * 1.2;

      // Flip horizontally to match mirror effect
      cursor.style.left = `${canvas.width - gazeX}px`;
      cursor.style.top = `${gazeY}px`;
    }

    // 👁 Blink detection (flashes red briefly)
    if (face.annotations?.leftEyeUpper0 && face.annotations?.leftEyeLower0) {
      const upper = face.annotations.leftEyeUpper0;
      const lower = face.annotations.leftEyeLower0;
      const eyeTopY = upper.reduce((a, p) => a + p[1], 0) / upper.length;
      const eyeBottomY = lower.reduce((a, p) => a + p[1], 0) / lower.length;
      const eyeDist = Math.abs(eyeTopY - eyeBottomY);

      if (eyeDist < 2 && Date.now() - lastBlink > 500) {
        lastBlink = Date.now();
        cursor.style.background = 'rgba(255,0,0,0.8)';
        setTimeout(() => (cursor.style.background = 'rgba(0,255,0,0.6)'), 200);
      }
    }
  } catch (err) {
    console.warn("Frame skipped:", err.message);
  }

  requestAnimationFrame(render);
}

init();

