import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
const EDGE="C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const port=9444, userDir="E:\\project\\LOL\\.cdp-probe";
const child=spawn(EDGE,["--headless=new","--disable-gpu","--no-first-run","--disable-extensions","--disable-sync","--mute-audio",`--remote-debugging-port=${port}`,`--user-data-dir=${userDir}`,"--window-size=1400,900","about:blank"],{stdio:"ignore"});
let list=null;
for(let i=0;i<60;i++){await sleep(300);try{const r=await fetch(`http://127.0.0.1:${port}/json/list`);list=await r.json();if(list.some(t=>t.type==="page"))break;}catch{}}
const page=list.find(t=>t.type==="page");
const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=()=>rej(new Error("ws"));});
let id=1;const pend=new Map();let dead=false;
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const{res,rej}=pend.get(m.id);pend.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);return;}
 if(m.method==="Inspector.targetCrashed")dead=true;
 if(m.method==="Runtime.exceptionThrown")console.error("PAGE-ERR",m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);};
const send=(method,params={})=>{const i=id++;ws.send(JSON.stringify({id:i,method,params}));return new Promise((res,rej)=>{pend.set(i,{res,rej});setTimeout(()=>{if(pend.has(i)){pend.delete(i);rej(new Error("timeout "+method));}},8000);});};
await send("Runtime.enable");await send("Page.enable");await send("Inspector.enable").catch(()=>{});
const evalx=async e=>{try{const r=await send("Runtime.evaluate",{expression:`(()=>{try{return (${e})}catch(err){return "ERR:"+err.message}})()`,returnByValue:true});return r.result?.value;}catch(err){return "FAIL:"+err.message;}};
const scenes=[
 ["网格 60 项（单页）","http://127.0.0.1:8777/web/?selftest=grid&limit=60&export=1"],
 ["网格 200 项（自动分页）","http://127.0.0.1:8777/web/?selftest=grid&limit=200"],
 ["网格 200 项（指定 2 页）","http://127.0.0.1:8777/web/?selftest=grid&limit=200&pages=2"],
 ["全图鉴 9158 项（自动分页）","http://127.0.0.1:8777/web/?selftest=grid&all=1"],
 ["海报","http://127.0.0.1:8777/web/?selftest=poster"],
 ["账号判定报告","http://127.0.0.1:8777/web/?selftest=me"],
];
for(const [label,url] of scenes){
  dead=false;
  console.log(`\n=== ${label} ===`);
  await send("Page.navigate",{url});
  await sleep(1000);
  let stage="?",done="?",t0=Date.now(),lastLog=0;
  while(Date.now()-t0<70000){
    const s=await evalx("window.__stage");
    const d=await evalx("window.__selftest");
    if(typeof s==="string"&&!s.startsWith("FAIL"))stage=s;
    if(typeof d==="string"&&!d.startsWith("FAIL"))done=d;
    const el=Math.round((Date.now()-t0)/1000);
    if(el-lastLog>=4){lastLog=el;console.log(`   t=${el}s  stage=${stage}  selftest=${done}`);}
    if(dead||done==="done"||String(done).startsWith("error"))break;
    await sleep(400);
  }
  const perf=await evalx("JSON.stringify(window.CollageCore && window.CollageCore.lastPerf || null)");
  const sub=await evalx("document.querySelector('#stageSub')?document.querySelector('#stageSub').textContent:'-'");
  const exp=await evalx("window.__exportSize===undefined?'-':window.__exportSize");
  const dlg=await evalx("JSON.stringify(window.__dialogs||[])");
  const pg=await evalx("document.querySelectorAll('#pageTabs button').length");
  console.log(`   结果: stage=${stage} selftest=${done} crashed=${dead} 用时=${Math.round((Date.now()-t0)/1000)}s`);
  console.log(`   成品: ${sub}   页签数=${pg}`);
  console.log(`   导出字节: ${exp}   提示: ${dlg}`);
  if(perf&&perf!=="null")console.log(`   perf=${perf}`);
}
ws.close();child.kill();await sleep(300);process.exit(0);
