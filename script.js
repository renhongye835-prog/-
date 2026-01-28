
/* Photo -> Bead pattern (client-side)
   Palettes:
   - Perler (57) & Hama (53) from Pixel-Beads public HEX charts.
   - Web216 is the classic 216-color (6×6×6) cube.
*/

const el = (id) => document.getElementById(id);

const upload = el("upload");
const sizeSel = el("size");
const paletteSel = el("palette");
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
  return {label:p.label, colors};
}

function drawPreview(){
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
  const s = parseInt(sizeSel.value,10);
  const palKey = paletteSel.value;
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
    const idx = nearestColorLab(lab, pal.colors);
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


function renderLabeled(){
  if(!lastResult || !canvasL) return;

  const s = lastResult.w;
  const cell = parseInt(cellSizeSel?.value ?? "12", 10);
  const fontSize = parseInt(fontSizeSel?.value ?? "12", 10);

  canvasL.width = s * cell;
  canvasL.height = s * cell;

  const ctx = canvasL.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0,0,canvasL.width,canvasL.height);

  // paint cells
  for(let y=0; y<s; y++){
    for(let x=0; x<s; x++){
      const p = y*s + x;
      const idx = lastResult.cellIndex[p];
      const c = lastResult.palette[idx];

      ctx.fillStyle = c.hex;
      ctx.fillRect(x*cell, y*cell, cell, cell);

      if(labelsChk?.checked){
        const lum = (0.2126*c.r + 0.7152*c.g + 0.0722*c.b);
        ctx.fillStyle = lum > 140 ? "rgba(0,0,0,0.85)" : "rgba(255,255,255,0.92)";
        ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(c.code, x*cell + cell/2, y*cell + cell/2);
      }
    }
  }

  // grid
  if(gridChk?.checked){
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
})();
