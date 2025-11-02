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

  // ✅ Load facemesh instead of face-landmarks-detection
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

    ctx.fillStyle = 'rgba(0,255,0,0.5)';
    for (const [x, y] of keypoints) {
      ctx.fillRect(x, y, 2, 2);
    }

    // Eye center between 159 and 386
    const leftEye = keypoints[159];
    const rightEye = keypoints[386];
    const dx = (leftEye[0] + rightEye[0]) / 2;
    const dy = (leftEye[1] + rightEye[1]) / 2;

    cursor.style.left = `${dx}px`;
    cursor.style.top = `${dy}px`;

    // Blink detection
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
