// =======================================
// Eye-Gaze Tracker v2.0
// Uses @tensorflow-models/face-landmarks-detection
// =======================================

let model, video, canvas, ctx;
let cursor, lastBlink = 0;
let smoothX = 0, smoothY = 0;
let blinkBaseline = null, baselineSamples = [], baselineReady = false;
let offCanvas, offCtx;

// ===== 444 Hz internal tone =====
function playBeep(f=444,d=0.15){
  const a=new (window.AudioContext||window.webkitAudioContext)();
  const o=a.createOscillator(), g=a.createGain();
  o.type="sine"; o.frequency.value=f;
  g.gain.setValueAtTime(0.2,a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001,a.currentTime+d);
  o.connect(g); g.connect(a.destination);
  o.start(); o.stop(a.currentTime+d);
}

// ===== camera =====
async function setupCamera(){
  video=document.getElementById("video");
  const stream=await navigator.mediaDevices.getUserMedia({video:true});
  video.srcObject=stream;
  await new Promise(r=>video.onloadedmetadata=r);
}

async function init(){
  cursor=document.getElementById("cursor");
  await setupCamera();

  canvas=document.getElementById("overlay");
  ctx=canvas.getContext("2d");
  offCanvas=document.createElement("canvas");
  offCtx=offCanvas.getContext("2d");
  resize(); window.addEventListener("resize",resize);

  console.log("Loading face-landmarks-detection...");
  model=await faceLandmarksDetection.load(
    faceLandmarksDetection.SupportedPackages.mediapipeFacemesh,
    {maxFaces:1}
  );
  console.log("✅ Model loaded");
  render();
}

function resize(){
  canvas.width=video.videoWidth; canvas.height=video.videoHeight;
  offCanvas.width=video.videoWidth; offCanvas.height=video.videoHeight;
}

function avg(pts){
  const s=pts.reduce((a,p)=>[a[0]+p[0],a[1]+p[1]],[0,0]);
  return [s[0]/pts.length,s[1]/pts.length];
}

function regionGap(mesh,top,bottom){
  const n=Math.min(top.length,bottom.length);
  let sum=0; for(let i=0;i<n;i++) sum+=Math.abs(mesh[top[i]][1]-mesh[bottom[i]][1]);
  return sum/n;
}

async function render(){
  // brighten for dim lighting
  offCtx.filter="brightness(1.4) contrast(1.3)";
  offCtx.drawImage(video,0,0,offCanvas.width,offCanvas.height);

  const faces=await model.estimateFaces({input:offCanvas});
  ctx.clearRect(0,0,canvas.width,canvas.height);

  if(faces.length>0){
    const f=faces[0], k=f.scaledMesh;

    // draw mesh
    ctx.fillStyle="rgba(0,255,0,0.6)";
    for(const [x,y] of k) ctx.fillRect(x,y,2,2);

    // pupils
    const lC=avg(k.slice(468,472)), rC=avg(k.slice(473,477));
    ctx.fillStyle="rgba(0,150,255,0.9)";
    ctx.beginPath();
    ctx.arc(lC[0],lC[1],3,0,2*Math.PI);
    ctx.arc(rC[0],rC[1],3,0,2*Math.PI);
    ctx.fill();

    // cursor follows gaze
    const nose=k[1];
    const dx=((lC[0]+rC[0])/2 - nose[0])*7;
    const dy=((lC[1]+rC[1])/2 - nose[1])*7;
    const targetX=canvas.width/2 - dx;
    const targetY=canvas.height/2 + dy;
    smoothX+=(targetX-smoothX)*0.15;
    smoothY+=(targetY-smoothY)*0.15;
    cursor.style.left=`${canvas.width-smoothX}px`;
    cursor.style.top=`${smoothY}px`;

    // eyelid gaps (multi-landmark like mouth)
    const leftTop=[159,160,161,246], leftBot=[145,144,153,154];
    const rightTop=[386,385,384,398], rightBot=[374,373,380,381];
    const leftGap=regionGap(k,leftTop,leftBot);
    const rightGap=regionGap(k,rightTop,rightBot);
    const eyeAvg=(leftGap+rightGap)/2;

    // baseline calibration
    if(!baselineReady){
      baselineSamples.push(eyeAvg);
      if(baselineSamples.length>60){
        blinkBaseline=baselineSamples.reduce((a,b)=>a+b,0)/baselineSamples.length;
        baselineReady=true;
        console.log("Blink baseline:",blinkBaseline.toFixed(3));
      }
    }else{
      const blinkThreshold=blinkBaseline*0.65;
      const blink=eyeAvg<blinkThreshold;
      ctx.strokeStyle="rgba(255,255,0,0.5)";
      ctx.beginPath();
      ctx.moveTo(k[159][0],k[159][1]); ctx.lineTo(k[145][0],k[145][1]);
      ctx.moveTo(k[386][0],k[386][1]); ctx.lineTo(k[374][0],k[374][1]);
      ctx.stroke();

      if(blink && Date.now()-lastBlink>700){
        lastBlink=Date.now();
        cursor.style.background="rgba(255,0,0,0.8)";
        playBeep(444,0.2);
        setTimeout(()=>cursor.style.background="rgba(0,255,0,0.6)",250);
        console.log("👁 Blink detected");
      }
    }
  }
  requestAnimationFrame(render);
}

init();
