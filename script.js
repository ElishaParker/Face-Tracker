let model, video, canvas, ctx;
let cursor, lastBlink = 0;

async function setupCamera() {
  video = document.getElementById('video');
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;
  await new Promise(resolve => video.onloadedmetadata = resolve);
}

async function init() {
  cursor = document.getElementById('cursor');
  await setupCamera();

  canvas = document.getElementById('overlay');
  ctx = canvas.getContext('2d');

  resize();
  window.addEventListener('resize', resize);

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

  if (predictions.length > 0 && predictions[0].scaledMesh) {
    const keypoints = predictions[0].scaledMesh;
    const face = predictions[0];

    // Draw mesh landmarks (optional)
    ctx.fillStyle = 'rgba(0,255,0,0.5)';
    for (const [x, y] of keypoints) {
      ctx.fillRect(x, y, 2, 2);
    }

    // ✅ Estimate eye gaze (left eye only)
    if (face.annotations?.leftEye && face.annotations?.leftEyeUpper0 && face.annotations?.leftEyeLower0) {
      const eyeInner = face.annotations.leftEye[3]; // inner corner
      const eyeOuter = face.annotations.leftEye[0]; // outer corner
      const upperMid = face.annotations.leftEyeUpper0[3];
      const lowerMid = face.annotations.leftEyeLower0[4];

      const eyeCenterX = (eyeInner[0] + eyeOuter[0]) / 2;
      const eyeCenterY = (upperMid[1] + lowerMid[1]) / 2;

      const eyeWidth = Math.abs(eyeOuter[0] - eyeInner[0]);
      const eyeHeight = Math.abs(upperMid[1] - lowerMid[1]);

      const normX = (eyeCenterX - eyeOuter[0]) / eyeWidth;
      const normY = (eyeCenterY - upperMid[1]) / eyeHeight;

      const gazeX = canvas.width - (normX * canvas.width); // flip X
      const gazeY = normY * canvas.height;

      cursor.style.left = `${gazeX}px`;
      cursor.style.top = `${gazeY}px`;
    }

    // ✅ Blink detection
    let eyeTopY, eyeBottomY;
    if (face.annotations.leftEyeUpper0 && face.annotations.leftEyeLower0) {
      const upper = face.annotations.leftEyeUpper0;
      const lower = face.annotations.leftEyeLower0;
      eyeTopY = upper.reduce((a, p) => a + p[1], 0) / upper.length;
      eyeBottomY = lower.reduce((a, p) => a + p[1], 0) / lower.length;
    } else {
      eyeTopY = keypoints[159][1];
      eyeBottomY = keypoints[145][1];
    }

    const eyeDist = Math.abs(eyeTopY - eyeBottomY);
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
