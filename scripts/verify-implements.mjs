// 筆記具バリエーション確認: chalk(短縮)/pencil/pen を、各サーフェスで「信高裕碩」書き途中で描く。
import { createCanvas } from "@napi-rs/canvas";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const HW = join(__dirname, "..", "public", "handwrite");

function shardName(cp){if(cp>=0x20&&cp<=0x7e)return"ascii.json";if(cp>=0x3040&&cp<=0x30ff)return"kana.json";if((cp>=0x3400&&cp<=0x9fff)||(cp>=0xf900&&cp<=0xfaff))return`kanji-${(cp>>8).toString(16)}.json`;return null;}
const cache=new Map();
function getGlyph(cp){if(cache.has(cp))return cache.get(cp);const f=shardName(cp);if(!f)return null;let j;try{j=JSON.parse(readFileSync(join(HW,f),"utf8"));}catch{return null;}for(const[k,g]of Object.entries(j.glyphs))cache.set(Number(k),{advance:g.advance,strokes:g.strokes.map(a=>{const p=[];for(let i=0;i+1<a.length;i+=2)p.push({x:a[i],y:a[i+1]});return p;})});return cache.get(cp)??null;}
function hashSeed(id){let h=2166136261;for(let i=0;i<id.length;i++){h^=id.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
function mulberry32(a){return()=>{a|=0;a=(a+0x6d2b79f5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function makeWobble(rng){const f1=1+rng()*1.5,f2=2.5+rng()*2,p1=rng()*Math.PI*2,p2=rng()*Math.PI*2,bias=(rng()-0.5)*0.4;return s=>Math.sin(s*Math.PI*2*f1+p1)*0.6+Math.sin(s*Math.PI*2*f2+p2)*0.4+bias;}
function jitterPolyline(pts,amp,wob){const n=pts.length;if(n<2||amp<=0)return pts;const out=[];for(let i=0;i<n;i++){const s=i/(n-1),a=pts[Math.max(0,i-1)],b=pts[Math.min(n-1,i+1)],dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy)||1,nx=-dy/len,ny=dx/len,taper=Math.sin(Math.min(1,Math.max(0,s))*Math.PI),off=wob(s)*amp*(0.3+0.7*taper);out.push({x:pts[i].x+nx*off,y:pts[i].y+ny*off});}return out;}
function shadeHex(hex,amt){const m=/^#?([0-9a-fA-F]{6})$/.exec(hex.trim());if(!m)return hex;const n=parseInt(m[1],16);let r=(n>>16)&255,g=(n>>8)&255,b=n&255;if(amt>=0){r+=(255-r)*amt;g+=(255-g)*amt;b+=(255-b)*amt;}else{r*=1+amt;g*=1+amt;b*=1+amt;}return`rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;}

const SURF={
  blackboard:{bg:"#2E3D34",ink:"#FAFAF0",tip:"chalk",frame:"#8b9c84"},
  notebook:{bg:"#FFFEF7",ink:"#1A237E",tip:"pencil",rule:true},
  whiteboard:{bg:"#FAFAFA",ink:"#2B6CB0",tip:"marker",border:"#DDDDDD"},
  none:{bg:"#15171a",ink:"#FFFFFF",tip:"pen"},
};

function drawImplement(ctx,tip,ink,fontPx,tipPt){
  const ang=-0.6;
  const L=tip==="chalk"?fontPx*0.55:tip==="pencil"?fontPx*1.25:tip==="marker"?fontPx*0.95:fontPx*1.0;
  const W=fontPx*0.17;
  ctx.save();ctx.translate(tipPt.x,tipPt.y);ctx.rotate(ang);
  ctx.save();ctx.globalAlpha=0.16;ctx.strokeStyle="#000";ctx.lineCap="round";ctx.lineWidth=W*1.05;ctx.beginPath();ctx.moveTo(W*0.6,W*0.6);ctx.lineTo(L,W*0.6);ctx.stroke();ctx.restore();
  const bg=base=>{const g=ctx.createLinearGradient(0,-W/2,0,W/2);g.addColorStop(0,shadeHex(base,0.3));g.addColorStop(0.5,base);g.addColorStop(1,shadeHex(base,-0.32));return g;};
  if(tip==="chalk"){
    ctx.strokeStyle=bg(ink);ctx.lineCap="round";ctx.lineWidth=W;ctx.beginPath();ctx.moveTo(W*0.45,0);ctx.lineTo(L,0);ctx.stroke();
    ctx.shadowColor=ink;ctx.shadowBlur=W*0.6;ctx.fillStyle=ink;ctx.beginPath();ctx.arc(0,0,W*0.34,0,Math.PI*2);ctx.fill();
  }else if(tip==="marker"){
    ctx.strokeStyle=bg(ink);ctx.lineCap="round";ctx.lineWidth=W*1.2;ctx.beginPath();ctx.moveTo(W*0.7,0);ctx.lineTo(L,0);ctx.stroke();
    ctx.strokeStyle="#d0d0d0";ctx.lineCap="butt";ctx.lineWidth=W*0.85;ctx.beginPath();ctx.moveTo(W*0.4,0);ctx.lineTo(W*0.72,0);ctx.stroke();
    ctx.fillStyle=shadeHex(ink,-0.4);ctx.beginPath();ctx.moveTo(0,-W*0.26);ctx.lineTo(W*0.42,-W*0.42);ctx.lineTo(W*0.42,W*0.42);ctx.lineTo(0,W*0.26);ctx.closePath();ctx.fill();
  }else if(tip==="pencil"){
    ctx.strokeStyle=bg("#EBB63E");ctx.lineCap="round";ctx.lineWidth=W;ctx.beginPath();ctx.moveTo(W*0.95,0);ctx.lineTo(L,0);ctx.stroke();
    ctx.fillStyle="#D79B33";ctx.beginPath();ctx.moveTo(W*0.28,-W*0.5);ctx.lineTo(W*0.95,-W*0.5);ctx.lineTo(W*0.95,W*0.5);ctx.lineTo(W*0.28,W*0.5);ctx.closePath();ctx.fill();
    ctx.fillStyle="#3a3a3a";ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(W*0.3,-W*0.34);ctx.lineTo(W*0.3,W*0.34);ctx.closePath();ctx.fill();
  }else{
    ctx.strokeStyle=bg("#2d2d34");ctx.lineCap="round";ctx.lineWidth=W*0.95;ctx.beginPath();ctx.moveTo(W*0.6,0);ctx.lineTo(L,0);ctx.stroke();
    ctx.fillStyle="#b9bcc4";ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(W*0.62,-W*0.4);ctx.lineTo(W*0.62,W*0.4);ctx.closePath();ctx.fill();
    ctx.fillStyle=ink;ctx.beginPath();ctx.arc(0,0,W*0.16,0,Math.PI*2);ctx.fill();
  }
  ctx.restore();
}

function render(text,p,surfName,fontSizeDesign){
  const S=SURF[surfName],pxScale=3,fontPx=fontSizeDesign*pxScale;
  const W=Math.ceil(text.length*fontPx+90),H=Math.ceil(fontPx+100);
  const cv=createCanvas(W,H),ctx=cv.getContext("2d");
  ctx.fillStyle=S.bg;ctx.fillRect(0,0,W,H);
  if(S.frame){ctx.fillStyle=S.frame;ctx.fillRect(0,0,W,10);ctx.fillRect(0,H-10,W,10);ctx.fillRect(0,0,10,H);ctx.fillRect(W-10,0,10,H);}
  if(S.border){ctx.strokeStyle=S.border;ctx.lineWidth=4;ctx.strokeRect(2,2,W-4,H-4);}
  const ink=S.ink,lineW=fontPx*0.05;
  const amp=0.3*fontPx*0.018,rng=mulberry32(hashSeed("imp")),all=[];
  let x=45;const cellTop=(H-fontPx)/2;
  if(S.rule){ctx.strokeStyle="rgba(120,170,210,0.55)";ctx.lineWidth=1;const by=cellTop+0.781*fontPx;ctx.beginPath();ctx.moveTo(0,by+6);ctx.lineTo(W,by+6);ctx.stroke();ctx.strokeStyle="rgba(220,90,90,0.5)";ctx.beginPath();ctx.moveTo(W*0.06,0);ctx.lineTo(W*0.06,H);ctx.stroke();}
  for(const ch of text){const g=getGlyph(ch.codePointAt(0));const adv=(g?g.advance:0.9)*fontPx;if(g)for(const s of g.strokes){let pts=s.map(q=>({x:x+q.x*fontPx,y:cellTop+q.y*fontPx}));pts=jitterPolyline(pts,amp,makeWobble(rng));all.push(pts);}x+=adv;}
  const drawCount=Math.round(p*all.length);
  ctx.lineCap="round";ctx.lineJoin="round";ctx.lineWidth=lineW;ctx.strokeStyle=ink;ctx.globalAlpha=surfName==="blackboard"?0.92:1;
  const chalk=S.tip==="chalk";
  for(let i=0;i<drawCount&&i<all.length;i++){
    const pts=all[i];
    if(chalk){ // grain（簡略）
      const base=ctx.globalAlpha;ctx.save();ctx.globalAlpha=base*0.62;ctx.lineWidth=lineW*0.82;ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);for(let j=1;j<pts.length;j++)ctx.lineTo(pts[j].x,pts[j].y);ctx.stroke();ctx.restore();
      ctx.save();ctx.fillStyle=ink;const step=Math.max(2,lineW*0.45);for(let j=1;j<pts.length;j++){const ax=pts[j-1].x,ay=pts[j-1].y,bx=pts[j].x,by=pts[j].y,sl=Math.hypot(bx-ax,by-ay)||1,tx=(bx-ax)/sl,ty=(by-ay)/sl,nx=-ty,ny=tx,ns=Math.max(1,Math.floor(sl/step));for(let k=0;k<ns;k++){const f=(k+0.5)/ns,cx=ax+(bx-ax)*f,cy=ay+(by-ay)*f,r=mulberry32(hashSeed(`${Math.round(cx)}_${Math.round(cy)}`));for(let gg=0;gg<2;gg++){if(r()<0.12)continue;const o=(r()-0.5)*lineW*0.85,al=(r()-0.5)*step,rad=lineW*(0.08+r()*0.2);ctx.globalAlpha=base*(0.25+r()*0.55);ctx.beginPath();ctx.arc(cx+nx*o+tx*al,cy+ny*o+ty*al,rad,0,Math.PI*2);ctx.fill();}}}ctx.restore();
    }else{ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);for(let j=1;j<pts.length;j++)ctx.lineTo(pts[j].x,pts[j].y);ctx.stroke();}
  }
  ctx.globalAlpha=1;
  if(drawCount>0&&drawCount<=all.length){const last=all[drawCount-1];drawImplement(ctx,S.tip,ink,fontPx,last[last.length-1]);}
  return cv.toBuffer("image/png");
}

const txt="信高裕碩";
writeFileSync(join(__dirname,"..","imp-chalk.png"),render(txt,0.55,"blackboard",56));
writeFileSync(join(__dirname,"..","imp-pencil.png"),render(txt,0.55,"notebook",56));
writeFileSync(join(__dirname,"..","imp-pen.png"),render(txt,0.55,"none",56));
writeFileSync(join(__dirname,"..","imp-marker.png"),render(txt,0.55,"whiteboard",56));
console.log("wrote imp-chalk / imp-pencil / imp-pen / imp-marker");
