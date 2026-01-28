
function syncToleranceUI(){
  if(!toleranceModeSel) return;
  const palKey = paletteSel ? paletteSel.value : "";
  // Only meaningful for A–M cn216 mapping
  if(palKey === "cn216"){
    toleranceModeSel.disabled = false;
    toleranceModeSel.parentElement && toleranceModeSel.parentElement.classList.remove("disabled");
  }else{
    toleranceModeSel.value = "strict";
    toleranceModeSel.disabled = true;
    toleranceModeSel.parentElement && toleranceModeSel.parentElement.classList.add("disabled");
  }
}


/* Photo -> Bead pattern (client-side)
   Palettes:
   - Perler (57) & Hama (53) from Pixel-Beads public HEX charts.
   - Web216 is the classic 216-color (6×6×6) cube.
*/

const el = (id) => document.getElementById(id);

const upload = el("upload");
const sizeSel = el("size");
const paletteSel = el("palette");
const schemeSel = el("scheme");
const gridChk = el("grid");
const btnConvert = el("convert");
const canvasO = el("original");
const canvasR = el("result");
const canvasL = el("labeled");
const labelsChk = el("labels");
const fontSizeSel = el("fontSize");
const cellSizeSel = el("cellSize");
const dlPng = el("downloadPng");
const dlCsv = el("downloadCsv");

const statTotal = el("statTotal");
const statUsed = el("statUsed");
const statPalette = el("statPalette");
const tableBody = el("table").querySelector("tbody");

let imgBitmap = null;
let palettes = null;
let lastResult = null; // {width,height, pixels:Uint8ClampedArray, counts:[...]}

async function loadPalettes(){
  const res = await fetch("./palettes.json");
  palettes = await res.json();
}


function syncPaletteLock(){
  if(!schemeSel || !paletteSel) return;
  const mode = schemeSel.value;

  if(mode === "cn216"){
    // 锁定为 A–M 实色216，避免出现“体系不一致”
    paletteSel.value = "cn216";
    paletteSel.disabled = true;
  }else{
    paletteSel.disabled = false;
    // 如果之前被锁在 cn216，切换到其他体系时，自动切到对应色卡
    if(paletteSel.value === "cn216"){
      paletteSel.value = mode; // perler57 / hama53 / web216
    }
  }

  // 更新说明文字（可选）
  const sub = document.querySelector(".subtitle");
  if(sub){
    if(mode === "cn216") sub.textContent = "A–M 实色216（标准色号，系列优先，不跨系列）";
    else if(mode === "perler57") sub.textContent = "Perler 官方色卡（57色）";
    else if(mode === "hama53") sub.textContent = "Hama 官方色卡（53色）";
    else sub.textContent = "通用 216 色（6×6×6）";
  }
}

function hexToRgb(hex){
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if(!m) return [0,0,0];
  const n = parseInt(m[1],16);
  return [(n>>16)&255, (n>>8)&255, n&255];
}

// sRGB -> linear
function srgbToLin(c){
  c/=255;
  return c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4);
}

// linear -> Lab helpers (D65)
function linToXyz(r,g,b){
  // sRGB D65
  const X = r*0.4124564 + g*0.3575761 + b*0.1804375;
  const Y = r*0.2126729 + g*0.7151522 + b*0.0721750;
  const Z = r*0.0193339 + g*0.1191920 + b*0.9503041;
  return [X,Y,Z];
}
function fLab(t){
  const d = 6/29;
  return t > Math.pow(d,3) ? Math.cbrt(t) : (t/(3*d*d) + 4/29);
}
function xyzToLab(X,Y,Z){
  // Reference white D65
  const Xn=0.95047, Yn=1.00000, Zn=1.08883;
  const fx=fLab(X/Xn), fy=fLab(Y/Yn), fz=fLab(Z/Zn);
  const L = 116*fy - 16;
  const a = 500*(fx - fy);
  const b = 200*(fy - fz);
  return [L,a,b];
}
function rgbToLab(r,g,b){
  const rl=srgbToLin(r), gl=srgbToLin(g), bl=srgbToLin(b);
  const [X,Y,Z]=linToXyz(rl,gl,bl);
  return xyzToLab(X,Y,Z);
}

function buildPalette(p){
  // p.colors: [{code,name,hex}]
  const colors = p.colors.map(c=>{
    const [r,g,b]=hexToRgb(c.hex);
    const lab=rgbToLab(r,g,b);
    return {...c, r,g,b, lab};
  });
  const pal={label:p.label, colors};
  // If codes look like A1/B15/... add series metadata
  const looksSeries = colors.length && /^[A-Z]\d+$/i.test(colors[0].code);
  return looksSeries ? enhancePaletteForSeries(pal) : pal;
}


function rgbToHsv01(r,g,b){
  r/=255; g/=255; b/=255;
  const mx=Math.max(r,g,b), mn=Math.min(r,g,b);
  const d=mx-mn;
  let h=0;
  if(d!==0){
    if(mx===r) h=((g-b)/d)%6;
    else if(mx===g) h=((b-r)/d)+2;
    else h=((r-g)/d)+4;
    h/=6;
    if(h<0) h+=1;
  }
  const s = mx===0 ? 0 : d/mx;
  const v = mx;
  return {h,s,v};
}

function enhancePaletteForSeries(pal){
  // Group by leading letter (A–M) for cn216 rules
  const bySeries = {};
  for(const c of pal.colors){
    const series = (c.code && c.code.length>0) ? c.code[0] : "?";
    if(!bySeries[series]) bySeries[series]=[];
    bySeries[series].push(c);
  }
  // Compute Lab centroid + hue centroid per series
  const seriesStats = {};
  for(const [series, arr] of Object.entries(bySeries)){
    let L=0,a=0,b=0;
    let sx=0, sy=0; // mean angle for hue
    let n=0;
    for(const c of arr){
      L+=c.lab[0]; a+=c.lab[1]; b+=c.lab[2];
      const hsv = rgbToHsv01(c.r,c.g,c.b);
      const ang = hsv.h * Math.PI*2;
      sx += Math.cos(ang);
      sy += Math.sin(ang);
      n++;
    }
    seriesStats[series]={
      lab:[L/n,a/n,b/n],
      hue: Math.atan2(sy/n, sx/n), // radians
    };
  }
  pal.bySeries = bySeries;
  pal.seriesStats = seriesStats;
  return pal;
}

function pickSeriesForPixel(r,g,b,pal){
  const hsv = rgbToHsv01(r,g,b);
  const s = hsv.s, v = hsv.v;
  const stats = pal.seriesStats || {};
  // neutrals: low saturation OR very dark/very bright
  const isNeutral = (s < 0.12) || (v < 0.12) || (v > 0.92 && s < 0.20);
  if(isNeutral){
    // choose between H and M if available; fall back to nearest centroid among all
    const candidates = [];
    if(stats["H"]) candidates.push("H");
    if(stats["M"]) candidates.push("M");
    const labs = rgbToLab(r,g,b);
    if(candidates.length){
      let best=candidates[0], bestD=Infinity;
      for(const k of candidates){
        const c=stats[k].lab;
        const dl=labs[0]-c[0], da=labs[1]-c[1], db=labs[2]-c[2];
        const d=dl*dl+da*da+db*db;
        if(d<bestD){bestD=d; best=k;}
      }
      return best;
    }
  }
  // colored: choose closest hue centroid among A–G by circular distance
  const hue = hsv.h * Math.PI*2;
  const seriesCandidates = ["A","B","C","D","E","F","G"];
  let best="A", bestD=Infinity;
  for(const k of seriesCandidates){
    if(!stats[k]) continue;
    const dh = Math.abs(hue - stats[k].hue);
    const d = Math.min(dh, Math.PI*2 - dh);
    if(d < bestD){ bestD=d; best=k; }
  }
  // if palette lacks these, fall back to any series
  if(bestD===Infinity){
    let any=Object.keys(stats);
    return any.length?any[0]:"A";
  }
  return best;
}

function nearestColorLabInSeries(lab, pal, series){
  const arr = pal.bySeries && pal.bySeries[series] ? pal.bySeries[series] : pal.colors;
  let bestIdx = 0;
  let bestD = Infinity;
  for(let i=0;i<arr.length;i++){
    const c = arr[i];
    const dl = lab[0]-c.lab[0];
    const da = lab[1]-c.lab[1];
    const db = lab[2]-c.lab[2];
    const d = dl*dl + da*da + db*db;
    if(d < bestD){ bestD=d; bestIdx=i; }
  }
  // Need to return index into pal.colors (global index) for downstream
  if(arr === pal.colors) return bestIdx;
  // map back to pal.colors index
  const code = arr[bestIdx].code;
  for(let j=0;j<pal.colors.length;j++){
    if(pal.colors[j].code === code) return j;
  }
  return 0;
}


function nearestColorLabInSeriesWithDist(lab, pal, series){
  const arr = pal.bySeries && pal.bySeries[series] ? pal.bySeries[series] : pal.colors;
  let bestLocal = 0;
  let bestD = Infinity;
  for(let i=0;i<arr.length;i++){
    const c = arr[i];
    const dl = lab[0]-c.lab[0];
    const da = lab[1]-c.lab[1];
    const db = lab[2]-c.lab[2];
    const d = dl*dl + da*da + db*db;
    if(d < bestD){ bestD=d; bestLocal=i; }
  }
  // Map to global index
  let globalIdx;
  if(arr === pal.colors){
    globalIdx = bestLocal;
  }else{
    const code = arr[bestLocal].code;
    globalIdx = 0;
    for(let j=0;j<pal.colors.length;j++){
      if(pal.colors[j].code === code){ globalIdx=j; break; }
    }
  }
  return { idx: globalIdx, d: bestD };
}

function nearestColorLabWithTolerance(r,g,b,lab,pal,primarySeries,mode){
  // strict: only primary series
  const primary = nearestColorLabInSeriesWithDist(lab, pal, primarySeries);
  if(mode !== "smart") return primary.idx;

  // smart tolerance:
  // if the best match inside the primary series is still far away, allow adjacent series search.
  // Threshold is squared distance in Lab space.
  const THRESH = 320; // ~deltaE 18 (since we use squared distance approximation)
  if(primary.d <= THRESH) return primary.idx;

  const neighbors = {
    "A":["A","G","B"],
    "B":["B","A","C"],
    "C":["C","B","D","E"],
    "D":["D","C","E"],
    "E":["E","D","C","F"],
    "F":["F","E","G"],
    "G":["G","F","A"],
    "H":["H","M"],
    "M":["M","H"]
  };
  const cand = neighbors[primarySeries] || [primarySeries];

  let best = primary;
  for(const s of cand){
    if(s === primarySeries) continue;
    if(!(pal.bySeries && pal.bySeries[s] && pal.bySeries[s].length)) continue;
    const res = nearestColorLabInSeriesWithDist(lab, pal, s);
    if(res.d < best.d) best = res;
  }
  return best.idx;
}


function drawPreview(){
  if(!imgBitmap) return;

  const s = parseInt(sizeSel.value,10);
  // Original preview canvas uses nearest-neighbor to show pixels
  canvasO.width = s;
  canvasO.height = s;
  canvasR.width = s;
  canvasR.height = s;

  // labeled canvas uses enlarged cells
  const cell = parseInt(cellSizeSel?.value ?? "12", 10);
  if(canvasL){
    canvasL.width = s * cell;
    canvasL.height = s * cell;
  }

  const ctxO = canvasO.getContext("2d", {willReadFrequently:true});
  ctxO.imageSmoothingEnabled = false;
  ctxO.clearRect(0,0,s,s);

  // Fit image to square with cover
  const tmp = document.createElement("canvas");
  tmp.width = s; tmp.height = s;
  const tctx = tmp.getContext("2d", {willReadFrequently:true});
  tctx.imageSmoothingEnabled = true;

  const iw = imgBitmap.width, ih = imgBitmap.height;
  const scale = Math.max(s/iw, s/ih);
  const nw = iw*scale, nh = ih*scale;
  const dx = (s-nw)/2, dy=(s-nh)/2;
  tctx.drawImage(imgBitmap, dx, dy, nw, nh);

  // draw on original (nearest for pixel look)
  ctxO.putImageData(tctx.getImageData(0,0,s,s),0,0);

  btnConvert.disabled = false;
}

function renderGrid(ctx, w, h){
  if(!gridChk.checked) return;
  ctx.save();
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  for(let x=0;x<=w;x++){
    ctx.beginPath();
    ctx.moveTo(x+0.5,0);
    ctx.lineTo(x+0.5,h);
    ctx.stroke();
  }
  for(let y=0;y<=h;y++){
    ctx.beginPath();
    ctx.moveTo(0,y+0.5);
    ctx.lineTo(w,y+0.5);
    ctx.stroke();
  }
  ctx.restore();
}

function nearestColorLab(lab, paletteColors){
  // brute force; small palettes OK (<=216)
  let best = 0;
  let bestD = Infinity;
  for(let i=0;i<paletteColors.length;i++){
    const c = paletteColors[i];
    const dl = lab[0]-c.lab[0];
    const da = lab[1]-c.lab[1];
    const db = lab[2]-c.lab[2];
    const d = dl*dl + da*da + db*db;
    if(d < bestD){ bestD = d; best = i; }
  }
  return best;
}

function convert(){
  if(!imgBitmap){ alert("请先上传一张照片再转换。"); return; }
  setStatus("正在计算配色…");
const s = parseInt(sizeSel.value,10);
  const mode = schemeSel ? schemeSel.value : paletteSel.value;
  // A–M 模式强制使用 cn216 色卡
  const palKey = (mode === "cn216") ? "cn216" : paletteSel.value;
  const pal = buildPalette(palettes[palKey]);

  // get pixels from original preview
  const ctxO = canvasO.getContext("2d", {willReadFrequently:true});
  const imgData = ctxO.getImageData(0,0,s,s);
  const data = imgData.data;

  const out = new Uint8ClampedArray(data.length);
  const counts = new Map(); // code -> {color, count}

  const cellIndex = new Uint16Array(s * s); // each cell -> palette index

  for(let i=0;i<data.length;i+=4){
    const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
    if(a < 10){
      // treat transparent as white-ish
      out[i]=255; out[i+1]=255; out[i+2]=255; out[i+3]=255;
      continue;
    }
    const lab = rgbToLab(r,g,b);
    let idx;
    if(palKey === "cn216" && pal.bySeries){
      const series = pickSeriesForPixel(r,g,b,pal);
      const mode = (toleranceModeSel && toleranceModeSel.value) ? toleranceModeSel.value : "strict";
      idx = nearestColorLabWithTolerance(r,g,b,lab,pal,series,mode);
    }else{
      idx = nearestColorLab(lab, pal.colors);
    }
    const c = pal.colors[idx];

    cellIndex[(i/4)] = idx;

    out[i]=c.r; out[i+1]=c.g; out[i+2]=c.b; out[i+3]=255;

    const key = c.code;
    const cur = counts.get(key) || {color:c, count:0};
    cur.count += 1;
    counts.set(key, cur);
  }

  // paint result
  const ctxR = canvasR.getContext("2d", {willReadFrequently:true});
  ctxR.imageSmoothingEnabled = false;
  ctxR.putImageData(new ImageData(out, s, s), 0, 0);
  renderGrid(ctxR, s, s);

  lastResult = {
    w:s, h:s, pixels:out,
    paletteLabel: pal.label,
    counts: Array.from(counts.values()).sort((a,b)=>b.count-a.count),
    cellIndex,
    palette: pal.colors
  };

  updateStats();
  updateTable();
  renderLabeled();
  // renderLabeled will clear status when done
}

function updateStats(){
  if(!lastResult) return;
  statTotal.textContent = `${lastResult.w}×${lastResult.h} = ${lastResult.w*lastResult.h}`;
  statUsed.textContent = `${lastResult.counts.length}`;
  statPalette.textContent = lastResult.paletteLabel;
}

function updateTable(){
  tableBody.innerHTML = "";
  if(!lastResult) return;

  for(const row of lastResult.counts){
    const tr = document.createElement("tr");
    const sw = document.createElement("td");
    const s = document.createElement("span");
    s.className="swatch";
    s.style.background = row.color.hex;
    sw.appendChild(s);

    const tdCode = document.createElement("td");
    tdCode.textContent = row.color.code;

    const tdName = document.createElement("td");
    tdName.textContent = row.color.name || "";

    const tdHex = document.createElement("td");
    tdHex.textContent = row.color.hex;

    const tdCnt = document.createElement("td");
    tdCnt.textContent = row.count;

    tr.append(sw, tdCode, tdName, tdHex, tdCnt);
    tableBody.appendChild(tr);
  }
}


let renderToken = 0;

function setStatus(msg){
  const s = document.getElementById("status");
  if(!s) return;
  s.textContent = msg || "";
}

function renderLabeled(){
  if(!lastResult || !canvasL) return;

  const token = ++renderToken;
  const s = lastResult.w;
  const cell = parseInt(cellSizeSel?.value ?? "20", 10);
  const fontSize = parseInt(fontSizeSel?.value ?? "14", 10);

  canvasL.width = s * cell;
  canvasL.height = s * cell;

  const ctx = canvasL.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0,0,canvasL.width,canvasL.height);

  const showText = (labelsChk?.checked) && cell >= 14;

  // 先画底色（这一步很快）
  const total = s * s;
  for(let p=0; p<total; p++){
    const idx = lastResult.cellIndex[p];
    const c = lastResult.palette[idx];
    const x = p % s;
    const y = (p / s) | 0;
    ctx.fillStyle = c.hex;
    ctx.fillRect(x*cell, y*cell, cell, cell);
  }

  // 网格先不画，等文字画完再画（避免多次覆盖）
  // 文字分批绘制，避免浏览器假死
  if(!showText){
    // 只画网格即可
    drawGrid(ctx, s, cell);
    setStatus("");
    return;
  }

  setStatus("正在生成色号… 0%");
  const chunk = 220; // 每帧绘制的格子数（越大越快但越卡）
  let p = 0;

  function step(){
    if(token !== renderToken) return; // 取消旧任务

    const end = Math.min(total, p + chunk);
    for(; p<end; p++){
      const idx = lastResult.cellIndex[p];
      const c = lastResult.palette[idx];
      const x = p % s;
      const y = (p / s) | 0;

      const lum = (0.2126*c.r + 0.7152*c.g + 0.0722*c.b);
      const fg = lum > 140 ? "rgba(0,0,0,0.92)" : "rgba(255,255,255,0.95)";
      const stroke = lum > 140 ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.55)";

      ctx.font = `800 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      ctx.lineWidth = Math.max(2, Math.floor(fontSize/6));
      ctx.strokeStyle = stroke;
      ctx.strokeText(c.code, x*cell + cell/2, y*cell + cell/2);

      ctx.fillStyle = fg;
      ctx.fillText(c.code, x*cell + cell/2, y*cell + cell/2);
    }

    const percent = Math.floor((p / total) * 100);
    setStatus(`正在生成色号… ${percent}%`);

    if(p < total){
      requestAnimationFrame(step);
    }else{
      drawGrid(ctx, s, cell);
      setStatus("");
    }
  }

  requestAnimationFrame(step);
}

function drawGrid(ctx, s, cell){
  if(!gridChk?.checked) return;
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  for(let x=0; x<=s; x++){
    ctx.beginPath();
    ctx.moveTo(x*cell+0.5, 0);
    ctx.lineTo(x*cell+0.5, s*cell);
    ctx.stroke();
  }
  for(let y=0; y<=s; y++){
    ctx.beginPath();
    ctx.moveTo(0, y*cell+0.5);
    ctx.lineTo(s*cell, y*cell+0.5);
    ctx.stroke();
  }
  ctx.restore();
}



function downloadCanvasPng(){
  if(!lastResult) return;
  const link = document.createElement("a");
  link.download = `bead_pattern_${lastResult.w}x${lastResult.h}.png`;
  link.href = (canvasL ?? canvasR).toDataURL("image/png");
  link.click();
}

function downloadCountsCsv(){
  if(!lastResult) return;
  const rows = [["code","name","hex","count"]];
  for(const r of lastResult.counts){
    rows.push([r.color.code, r.color.name, r.color.hex, r.count]);
  }
  const csv = rows.map(r=>r.map(x=>{
    const s = String(x ?? "");
    return /[",\n]/.test(s) ? `"${s.replaceAll('"','""')}"` : s;
  }).join(",")).join("\n");

  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bead_counts_${lastResult.w}x${lastResult.h}.csv`;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

upload.addEventListener("change", async (e)=>{
  const file = e.target.files?.[0];
  if(!file) return;
  imgBitmap = await createImageBitmap(file);
  drawPreview();
});

gridChk.addEventListener("change", ()=>{
  if(!lastResult) return;
  convert();
});


labelsChk?.addEventListener("change", renderLabeled);
fontSizeSel?.addEventListener("change", renderLabeled);
cellSizeSel?.addEventListener("change", ()=>{
  if(imgBitmap) drawPreview();
  if(lastResult) convert();
});


btnConvert.addEventListener("click", convert);
dlPng.addEventListener("click", (e)=>{ e.preventDefault(); downloadCanvasPng(); });
dlCsv.addEventListener("click", (e)=>{ e.preventDefault(); downloadCountsCsv(); });

(async function init(){
  await loadPalettes();
  syncPaletteLock();
})();
