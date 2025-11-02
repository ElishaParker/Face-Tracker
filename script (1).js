// =====================================================
// Assistive Eye‑Gaze Tracker
//
// This script combines two complementary technologies to provide
// accessible hands‑free cursor control and click actions:
//
//   • WebGazer.js (loaded asynchronously) supplies live gaze
//     predictions as screen coordinates.  These coordinates drive
//     the on‑screen cursor indicator in real time.
//
//   • TensorFlow.js FaceMesh runs in parallel on a downsampled video
//     feed.  It detects facial landmarks to derive blink events via
//     eyelid separation.  When both eyes close beyond a calibrated
//     threshold, the cursor flashes red and a 444 Hz tone plays to
//     indicate an activation (click).
//
// Additional features include adaptive brightness and contrast based
// on the scene illumination, and an attempt to configure the camera’s
// exposure if supported.  The video feed is mirrored for intuitive
// cursor motion.

let model, video, canvas, ctx;
let cursor, lastBlink = 0;
let gazeX = 0, gazeY = 0;    // coordinates from WebGazer
let smoothX = 0, smoothY = 0; // smoothed cursor position
let offCanvas, offCtx;        // off‑screen canvas for filtering
let blinkBaseline = null;
let baselineSamples = [];
let baselineReady = false;

// Dynamic brightness/contrast factors.  These are updated on the fly
// based on measured frame luminance to keep the model robust in
// low‑light environments.
let brightnessFactor = 1.3;
let contrastFactor = 1.2;

/**
 * Play a short tone to signal a blink click.  Uses the Web Audio API.
 * @param {number} f Frequency in Hz
 * @param {number} d Duration in seconds
 */
function playBeep(f = 444, d = 0.15) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = f;
  gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + d);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + d);
}

/**
 * Attempt to enable continuous exposure control on the webcam.  Not all
 * browsers or devices support this, so failure is silently ignored.
 *
 * @param {MediaStreamTrack} track The video track to adjust.
 */
async function applyExposureCompensation(track) {
  if (!track || !track.getCapabilities) return;
  const caps = track.getCapabilities();
  if (caps.exposureCompensation) {
    const { min, max } = caps.exposureCompensation;
    const mid = (min + max) / 2;
    try {
      await track.applyConstraints({ advanced: [{ exposureMode: "continuous", exposureCompensation: mid }] });
      console.log("✅ Exposure compensation applied:", mid);
    } catch (err) {
      console.warn("⚠️ Exposure control unsupported:", err);
    }
  }
}

/**
 * Set up the webcam and apply exposure adjustments where available.
 */
async function setupCamera() {
  video = document.getElementById("video");
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } });
  video.srcObject = stream;
  const track = stream.getVideoTracks()[0];
  await applyExposureCompensation(track);
  await new Promise(resolve => (video.onloadedmetadata = resolve));
}

/**
 * Initialize the entire system: camera, canvases, FaceMesh, WebGazer.
 */
async function init() {
  cursor = document.getElementById("cursor");
  await setupCamera();

  canvas = document.getElementById("overlay");
  ctx = canvas.getContext("2d");
  offCanvas = document.createElement("canvas");
  offCtx = offCanvas.getContext("2d");
  resize();
  window.addEventListener("resize", resize);

  // Load FaceMesh model (TensorFlow.js)
  model = await facemesh.load();
  console.log("✅ FaceMesh loaded");

  // Start WebGazer
  loadWebGazer();

  // Kick off render loop
  requestAnimationFrame(render);
}

/**
 * Adjust the size of canvases when the video dimensions change.
 */
function resize() {
  canvas.width = video.videoWidth || canvas.clientWidth;
  canvas.height = video.videoHeight || canvas.clientHeight;
  offCanvas.width = canvas.width;
  offCanvas.height = canvas.height;
}

/**
 * Compute the arithmetic mean of a list of 2D points.
 * @param {Array<Array<number>>} pts
 */
function avg(pts) {
  const sum = pts.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
  return [sum[0] / pts.length, sum[1] / pts.length];
}

/**
 * Compute the average vertical gap between matched top and bottom facial
 * landmark indices.  This is used to derive the eyelid separation,
 * similar to mouth logic.
 *
 * @param {Array<Array<number>>} mesh
 * @param {Array<number>} topIndices
 * @param {Array<number>} bottomIndices
 */
function regionGap(mesh, topIndices, bottomIndices) {
  const n = Math.min(topIndices.length, bottomIndices.length);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += Math.abs(mesh[topIndices[i]][1] - mesh[bottomIndices[i]][1]);
  }
  return sum / n;
}

/**
 * Measure the relative brightness of the current offscreen frame.  Returns
 * a value in the range [0, 1], where 0 is dark and 1 is bright.
 */
function measureFrameBrightness() {
  const frame = offCtx.getImageData(0, 0, offCanvas.width, offCanvas.height);
  const data = frame.data;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    total += (data[i] + data[i + 1] + data[i + 2]) / 3;
  }
  const pixels = data.length / 4;
  return (total / pixels) / 255;
}

/**
 * Dynamically adjust brightness and contrast factors based on measured
 * scene luminance.  Brighter scenes yield lower multipliers, while
 * darker scenes are boosted.
 *
 * @param {number} brightnessMeas 0–1 normalized luminance
 */
function adaptLighting(brightnessMeas) {
  if (brightnessMeas < 0.30) {
    brightnessFactor = 1.8;
    contrastFactor = 1.4;
  } else if (brightnessMeas < 0.50) {
    brightnessFactor = 1.5;
    contrastFactor = 1.3;
  } else if (brightnessMeas > 0.80) {
    brightnessFactor = 1.0;
    contrastFactor = 1.0;
  } else {
    brightnessFactor = 1.2;
    contrastFactor = 1.2;
  }
}

/**
 * Load WebGazer dynamically and set up gaze listener.  Once loaded it
 * continuously updates the global gazeX/Y variables.  Smoothing occurs
 * in the render loop.
 */
function loadWebGazer() {
  if (window.webgazer) {
    startWebGazer();
  } else {
    const script = document.createElement("script");
    script.src = "https://webgazer.cs.brown.edu/webgazer.js";
    script.onload = () => startWebGazer();
    document.head.appendChild(script);
  }
}

function startWebGazer() {
  console.log("🎯 WebGazer starting...");
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
  console.log("✅ WebGazer ready.  Perform calibration if prompted.");
}

/**
 * Primary render loop.  Handles brightness adaptation, FaceMesh
 * prediction, blink detection and beep, and cursor motion.
 */
async function render() {
  // Draw a raw frame to offscreen canvas for brightness measurement
  offCtx.filter = "";
  offCtx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);
  const luminance = measureFrameBrightness();
  adaptLighting(luminance);
  // Apply brightness/contrast filter for the model input
  offCtx.filter = `brightness(${brightnessFactor}) contrast(${contrastFactor})`;
  offCtx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);

  const faces = await model.estimateFaces(offCanvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (faces.length > 0) {
    const face = faces[0];
    const keypoints = face.scaledMesh;
    // Draw landmarks for debugging
    ctx.fillStyle = "rgba(0,255,0,0.6)";
    for (const [x, y] of keypoints) ctx.fillRect(x, y, 2, 2);

    // Eye gap indices for blink detection
    const leftTop = [159, 160, 161, 246];
    const leftBot = [145, 144, 153, 154];
    const rightTop = [386, 385, 384, 398];
    const rightBot = [374, 373, 380, 381];
    const leftGap = regionGap(keypoints, leftTop, leftBot);
    const rightGap = regionGap(keypoints, rightTop, rightBot);
    const eyeAvg = (leftGap + rightGap) / 2;

    // Blink baseline calibration over first ~60 frames
    if (!baselineReady) {
      baselineSamples.push(eyeAvg);
      if (baselineSamples.length > 60) {
        blinkBaseline = baselineSamples.reduce((a, b) => a + b, 0) / baselineSamples.length;
        baselineReady = true;
        console.log("Blink baseline set:", blinkBaseline.toFixed(3));
      }
    } else {
      // Determine blink threshold as a fraction of open‑eye baseline
      const blinkThreshold = blinkBaseline * 0.65;
      const blink = eyeAvg < blinkThreshold;
      // Visual eyelid indicator
      ctx.strokeStyle = "rgba(255,255,0,0.5)";
      ctx.beginPath();
      ctx.moveTo(keypoints[159][0], keypoints[159][1]);
      ctx.lineTo(keypoints[145][0], keypoints[145][1]);
      ctx.moveTo(keypoints[386][0], keypoints[386][1]);
      ctx.lineTo(keypoints[374][0], keypoints[374][1]);
      ctx.stroke();
      if (blink && Date.now() - lastBlink > 700) {
        lastBlink = Date.now();
        cursor.style.background = "rgba(255,0,0,0.8)";
        playBeep(444, 0.2);
        setTimeout(() => (cursor.style.background = "rgba(0,255,0,0.6)"), 250);
        console.log("👁 Blink detected");
      }
    }
  }
  // Smooth gaze to cursor position
  const smoothing = 0.2;
  smoothX += (gazeX - smoothX) * smoothing;
  smoothY += (gazeY - smoothY) * smoothing;
  cursor.style.left = `${smoothX}px`;
  cursor.style.top = `${smoothY}px`;

  requestAnimationFrame(render);
}

// Start everything
init();