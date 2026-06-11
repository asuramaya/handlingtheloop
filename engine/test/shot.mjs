import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const URL_TO_OPEN = process.argv[2], OUT = process.argv[3] || "/tmp/shot.png", PORT = 9444;
const profile = mkdtempSync(join(tmpdir(), "htl-shot-"));
const chrome = spawn("/snap/bin/chromium", ["--headless=new","--no-sandbox","--disable-gpu","--disable-dev-shm-usage",`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,"about:blank"]);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
try {
  let ws=null;
  for(let i=0;i<80;i++){ try{ const r=await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_TO_OPEN)}`,{method:"PUT"}); if(r.ok){ws=(await r.json()).webSocketDebuggerUrl;break;} }catch{} await sleep(150); }
  if(!ws) throw new Error("no target");
  const sock=new WebSocket(ws); await new Promise((res,rej)=>{sock.onopen=res;sock.onerror=rej;});
  let id=0; const pend=new Map();
  sock.onmessage=ev=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}};
  const send=(method,params={})=>new Promise(r=>{const i=++id;pend.set(i,r);sock.send(JSON.stringify({id:i,method,params}));});
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:2,mobile:true});
  await send("Emulation.setUserAgentOverride",{userAgent:"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"});
  await send("Page.navigate",{url:URL_TO_OPEN});
  await sleep(6000);
  const {result}=await send("Page.captureScreenshot",{format:"png"});
  writeFileSync(OUT, Buffer.from(result.data,"base64"));
  console.log("saved",OUT);
} finally { try{chrome.kill("SIGKILL");}catch{} try{rmSync(profile,{recursive:true,force:true});}catch{} }
