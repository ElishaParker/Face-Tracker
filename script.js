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
  const predictions = await model.estimateFaces(video);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (predictions.length > 0) {
    const face = predictions[0];
    const keypoints = face.scaledMesh;

    // Draw mesh landmarks (optional)
    ctx.fillStyle = 'rgba(0,255,0,0.5)';
    for (const [x, y] of keypoints) {
      ctx.fillRect(x, y, 2, 2);
    }

    // ✅ Eye gaze estimation (stable + visible)
    if (face.annotations?.leftEyeUpper0 && face.annotations?.leftEyeLower0 && face.annotations?.leftEye) {
      const leftEyeUpper = face.annotations.leftEyeUpper0;
      const leftEyeLower = face.annotations.leftEyeLower0;
      const leftEyeOuter = face.annotations.leftEye[0]; // outer corner
      const leftEyeInner = face.annotations.leftEye[3]; // inner corner

      // Approximate eye center
      const eyeCenterX = (leftEyeOuter[0] + leftEyeInner[0]) / 2;
      const eyeCenterY = (leftEyeUpper[3][1] + leftEyeLower[3][1]) / 2;

      const eyeWidth = Math.abs(leftEyeOuter[0] - leftEyeInner[0]);
      const eyeHeight = Math.abs(leftEyeUpper[3][1] - leftEyeLower[3][1]);

      // Normalize gaze offsets
      const offsetX = (eyeCenterX - leftEyeInner[0]) / eyeWidth - 0.5;
      const offsetY = (eyeCenterY - (leftEyeUpper[3][1] + eyeHeight / 2)) / eyeHeight;

      // Scale to canvas space
      const gazeX = canvas.width / 2 - offsetX * canvas.width * 0.8;
      const gazeY = canvas.height / 2 + offsetY * canvas.height * 0.8;

      // Flip X to match mirrored view
      cursor.style.left = `${canvas.width - gazeX}px`;
      cursor.style.top = `${gazeY}px`;
    }

    // ✅ Blink detection (optional visual cue)
    if (face.annotations?.leftEyeUpper0 && face.annotations?.leftEyeLower0) {
      const upper = face.annotations.leftEyeUpper0;
      const lower = face.annotations.leftEyeLower0;
      const eyeTopY = upper.reduce((a, p) => a + p[1], 0) / upper.length;
      const eyeBottomY = lower.reduce((a, p) => a + p[1], 0) / lower.length;

      const eyeDist = Math.abs(eyeTopY - eyeBottomY);
      if (eyeDist < 2 && Date.now() - lastBlink > 500) {
        lastBlink = Date.now();
        cursor.style.background = 'rgba(255,0,0,0.8)';
        setTimeout(() => {
          cursor.style.background = 'rgba(0,255,0,0.6)';
        }, 200);
      }
    }
  }

  requestAnimationFrame(render);
}

init();
