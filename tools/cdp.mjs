/**
 * 无头浏览器驱动（CDP / 零依赖，Node 18+）
 *
 * 用途：验证 web/ 页面是否真的跑起来了 —— 拿到控制台报错、页面异常、指定 JS 表达式的值，
 *       按「等待条件」截图，而不是盲猜截图时机。
 *
 * 用法：
 *   node tools/cdp.mjs --url "http://127.0.0.1:8777/web/" --wait "window.__selftest==='done'" \
 *        --timeout 120000 --shot _shots/a.png --eval "document.querySelector('#dbStat').textContent"
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = process.env.EDGE_PATH ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const url = arg('url', 'http://127.0.0.1:8777/web/');
const waitExpr = arg('wait', null);
const timeout = Number(arg('timeout', 60000));
const shot = arg('shot', null);
const evals = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--eval') evals.push(process.argv[i + 1]);
}
const width = Number(arg('width', 1600));
const height = Number(arg('height', 1200));
const gpuOff = process.argv.includes('--no-gpu-off');
const extraHeaders = arg('headers', null);
// --upload <selector>::<file>  给文件输入框塞一个真实文件，验证上传流程
const uploadSpec = arg('upload', null);
const port = Number(arg('port', 9333));
// 必须用绝对路径：相对路径会随调用时的工作目录变化，导致多个实例共用/损坏 profile
const scriptDir = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const userDir = resolve(scriptDir, '..', `.cdp-profile-${port}`);

let nextId = 1;
const pending = new Map();
const consoleMsgs = [];
const pageErrors = [];
let crashed = null;

function send(ws, method, params = {}, sessionId) {
  const id = nextId++;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // 评估类调用用短超时：主线程被长任务堵住时要快速失败并重试，而不是把整个工具拖死
    const ms = /^Runtime\.evaluate/.test(method) ? 8000 : 120000;
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
    }, ms);
  });
}

async function main() {
  if (existsSync(userDir)) rmSync(userDir, { recursive: true, force: true });

  const baseArgs = [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--mute-audio', '--hide-scrollbars',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`,
    `--window-size=${width},${height}`,
  ];
  if (!gpuOff) baseArgs.push('--disable-gpu');
  baseArgs.push('about:blank');
  const child = spawn(EDGE, baseArgs, { stdio: 'ignore' });

  // 等 DevTools 端口就绪
  let list = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      list = await r.json();
      if (list.some(t => t.type === 'page')) break;
    } catch { /* 还没起来 */ }
  }
  if (!list) throw new Error('无法连接 DevTools 端口');
  const page = list.find(t => t.type === 'page');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = e => rej(new Error('ws error')); });

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      consoleMsgs.push({
        type: m.params.type,
        text: m.params.args.map(a => a.value ?? a.description ?? a.type).join(' '),
      });
    } else if (m.method === 'Inspector.targetCrashed') {
      crashed = 'targetCrashed';
    } else if (m.method === 'Page.frameDetached') {
      crashed = 'frameDetached';
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      pageErrors.push(d.exception?.description || d.text);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error' || e.level === 'warning') {
        consoleMsgs.push({ type: 'log:' + e.level, text: e.text + (e.url ? ' @' + e.url : '') });
      }
    }
  };

  await send(ws, 'Runtime.enable');
  await send(ws, 'Log.enable');
  await send(ws, 'Page.enable');
  await send(ws, 'DOM.enable').catch(() => { });
  await send(ws, 'Inspector.enable').catch(() => { });
  await send(ws, 'Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });

  await send(ws, 'Page.navigate', { url });

  // 真实文件上传：DOM.setFileInputFiles 会触发 change 事件，等同用户手选文件
  if (uploadSpec) {
    const [sel, file] = String(uploadSpec).split('::');
    await sleep(1500);
    const doc = await send(ws, 'DOM.getDocument', { depth: -1, pierce: true });
    const q = await send(ws, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel });
    if (!q.nodeId) throw new Error('找不到文件输入框: ' + sel);
    await send(ws, 'DOM.setFileInputFiles', { files: [resolve(file)], nodeId: q.nodeId });
  }

  // 等待条件
  let waitResult = null;
  if (waitExpr) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        const r = await send(ws, 'Runtime.evaluate', {
          expression: `(()=>{try{return String(${waitExpr})}catch(e){return 'ERR:'+e.message}})()`,
          returnByValue: true, awaitPromise: false,
        });
        waitResult = r.result?.value;
        if (waitResult === 'true') break;
      } catch { /* 导航中 */ }
      await sleep(500);
    }
  } else {
    await sleep(Math.min(timeout, 6000));
  }

  const results = {};
  for (const e of evals) {
    try {
      const r = await send(ws, 'Runtime.evaluate', {
        expression: `(()=>{try{return (${e})}catch(err){return 'ERR:'+err.message}})()`,
        returnByValue: true, awaitPromise: true,
      });
      results[e] = r.result?.value;
    } catch (err) {
      results[e] = 'EVAL_FAIL: ' + err.message;
    }
  }

  let shotInfo = null;
  if (shot) {
    // 只截视口，不要整页（整页会把 fixed 遮罩和滚动外的内容一起拍进来，容易误判）
    const r = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    mkdirSync(dirname(shot), { recursive: true });
    writeFileSync(shot, Buffer.from(r.data, 'base64'));
    shotInfo = { path: shot, bytes: Buffer.from(r.data, 'base64').length };
  }

  const out = {
    url, waitExpr, waitResult, passed: waitExpr ? waitResult === 'true' : null, crashed,
    pageErrors, console: consoleMsgs.slice(0, 60), evals: results, shot: shotInfo,
  };
  console.log(JSON.stringify(out, null, 2));

  ws.close();
  child.kill();
  await sleep(300);
  try { rmSync(userDir, { recursive: true, force: true }); } catch { }
  process.exit(0);
}

main().catch(e => {
  console.log(JSON.stringify({ fatal: String(e) }, null, 2));
  process.exit(1);
});
