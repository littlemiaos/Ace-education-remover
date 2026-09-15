/*
 * tools/e2e.mjs — 用真实浏览器(Edge/Chrome)+ CDP 验证补丁真的跑得起来
 *
 * 静态检查只能证明「能解析」。这个脚本把扩展装进一个真实的 Chromium,然后断言:
 *   · MAIN world 注入是否生效、取值是否正确
 *   · 伪装层(toString / name / 描述符 / Date 原型链)是否自洽
 *   · 虚拟调度器在「后台」期间是否正确补投递定时器与帧,虚拟时钟是否单调
 *   · release 之后时钟是否连续、漂移是否接近 0
 *   · harness 自身的即时检查是否零异常、零 leak
 *
 * 为什么不直接测「真·切标签页」:headless 下能否用 CDP 可靠地翻转 document.hidden
 * 依版本而变。这里改为直接驱动遮蔽层的 hold/pump/release —— 那是真实后台路径上调用的
 * 同一组函数,而「真实后台」的判定交给 harness 在人工场景里量。两边合起来才完整。
 *
 * 运行:node tools/e2e.mjs
 *   PVG_BROWSER 环境变量可指定浏览器可执行文件路径。
 */

import http from 'node:http';
import { readFile, mkdtemp, mkdir, cp, writeFile, rm, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTTP_PORT = 8766;
const CDP_PORT = 9333;

const BROWSER_CANDIDATES = [
  process.env.PVG_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8'
};

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
};
const near = (v, target, tol) => typeof v === 'number' && isFinite(v) && Math.abs(v - target) <= tol;

/* ------------------------------------------------------------ 静态服务器 */

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
      if (rel === 'favicon.ico') {
        res.writeHead(204).end();
        return;
      }
      const file = path.join(ROOT, rel || 'harness/index.html');
      if (!file.startsWith(ROOT)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(HTTP_PORT, '127.0.0.1', () => resolve(server)));
}

/* --------------------------------------------------------------- CDP 客户端 */

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let seq = 0;
    const pending = new Map();
    const events = [];

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
        return;
      }
      if (msg.method) events.push(msg);
    };
    ws.onerror = () => reject(new Error('WebSocket 连接失败:' + url));
    ws.onopen = () =>
      resolve({
        events,
        send(method, params) {
          const id = ++seq;
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params: params || {} }));
          });
        },
        close: () => ws.close()
      });
  });
}

async function httpJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (_) {}
    await sleep(250);
  }
  throw new Error('等待 ' + url + ' 超时');
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('页面异常:' + String((d.exception && d.exception.description) || d.text));
  }
  return r.result.value;
}

/* ------------------------------------------------------------- 测试用扩展 */

const TEST_MANIFEST = {
  manifest_version: 3,
  name: 'PVG e2e test build',
  version: '0.0.0',
  minimum_chrome_version: '119',
  permissions: ['storage', 'scripting', 'activeTab'],
  host_permissions: ['<all_urls>'],
  background: { service_worker: 'src/background.js', type: 'module' },
  content_scripts: [
    {
      matches: ['http://127.0.0.1/*'],
      js: [
        'src/main/00-core.js',
        'src/main/10-visibility.js',
        'src/main/20-focus.js',
        'src/main/40-timing-clock.js',
        'src/main/41-timing-sched.js',
        'src/main/42-timing-raf.js'
      ],
      run_at: 'document_start',
      all_frames: true,
      world: 'MAIN',
      match_origin_as_fallback: true
    },
    {
      matches: ['http://127.0.0.1/*'],
      js: ['src/bridge.js'],
      run_at: 'document_start',
      all_frames: true,
      match_origin_as_fallback: true
    }
  ]
};

/* ------------------------------------------------------------------ 主流程 */

let server = null;
let browser = null;
let tmpRoot = null;

try {
  /* 1. 找到浏览器 */
  let browserPath = null;
  for (const c of BROWSER_CANDIDATES) {
    try {
      await access(c);
      browserPath = c;
      break;
    } catch (_) {}
  }
  if (!browserPath) {
    console.log('  跳过:没找到 Chromium 系浏览器(可用 PVG_BROWSER 指定路径)');
    process.exitCode = 0;
    process.exit(0);
  }
  console.log(`\n  浏览器:${browserPath}`);

  /* 2. 组装测试用扩展(静态 content_scripts,绕开需要人工授权的动态注册) */
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'pvg-e2e-'));
  const extDir = path.join(tmpRoot, 'ext');
  await mkdir(extDir, { recursive: true });
  await cp(path.join(ROOT, 'src'), path.join(extDir, 'src'), { recursive: true });
  await writeFile(path.join(extDir, 'manifest.json'), JSON.stringify(TEST_MANIFEST, null, 2));

  /* 3. 起服务器 */
  server = await startServer();
  const page = `http://127.0.0.1:${HTTP_PORT}/harness/index.html`;

  /* 4. 起浏览器 */
  const profile = path.join(tmpRoot, 'profile');
  browser = spawn(
    browserPath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--load-extension=${extDir}`,
      `--disable-extensions-except=${extDir}`,
      `--remote-debugging-port=${CDP_PORT}`,
      '--remote-allow-origins=*',
      'about:blank'
    ],
    { stdio: 'ignore', windowsHide: true }
  );

  const list = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const target = list.find((t) => t.type === 'page');
  if (!target) throw new Error('没有找到 page target');

  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');

  /* 扩展上下文:拿扩展 id,并开一个 options 页当「发消息」的通道。
     service worker 自己发出的 sendMessage 不会被自己的 onMessage 收到,
     所以驱动 pvg:* 接口必须换一个扩展上下文来发。 */
  const getTargets = () => httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`, 4);

  let swTarget = null;
  for (let i = 0; i < 40; i++) {
    const ts = await getTargets().catch(() => []);
    swTarget = ts.find((t) => t.type === 'service_worker' && String(t.url).includes('/src/background.js'));
    if (swTarget) break;
    await sleep(250);
  }
  const extId = swTarget ? new URL(swTarget.url).host : null;
  check('service worker 已就绪', !!swTarget, extId || '未找到');

  async function evalRetry(c, expr, tries = 15) {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        return await evaluate(c, expr);
      } catch (e) {
        last = e;
        await sleep(200);
      }
    }
    throw last;
  }

  let swCdp = null;
  if (swTarget) {
    try {
      swCdp = await connect(swTarget.webSocketDebuggerUrl);
      await swCdp.send('Runtime.enable');
    } catch (_) {
      swCdp = null;
    }
  }

  let optCdp = null;
  if (extId) {
    try {
      const browser = await connect(
        (await httpJson(`http://127.0.0.1:${CDP_PORT}/json/version`, 5)).webSocketDebuggerUrl
      );
      const created = await browser.send('Target.createTarget', {
        url: `chrome-extension://${extId}/src/options.html`
      });
      // 把被测页拉回前台:否则它会变成后台标签页,后续断言会在冻结态下跑
      await browser.send('Target.activateTarget', { targetId: target.id }).catch(() => {});
      browser.close();
      for (let i = 0; i < 40 && !optCdp; i++) {
        const ts = await getTargets().catch(() => []);
        const t =
          ts.find((x) => x.id === created.targetId) || ts.find((x) => String(x.url).includes('/src/options.html'));
        if (t) {
          optCdp = await connect(t.webSocketDebuggerUrl);
          await optCdp.send('Runtime.enable');
        } else {
          await sleep(200);
        }
      }
    } catch (_) {
      optCdp = null;
    }
  }
  check('扩展上下文可用(options 页)', !!optCdp);

  const REGS_EXPR =
    'chrome.scripting.getRegisteredContentScripts().then(l=>l.map(s=>({id:s.id,matches:s.matches,' +
    'persist:s.persistAcrossSessions,world:s.world,js:s.js})))';
  async function regs() {
    const errs = [];
    for (const [label, c] of [
      ['options', optCdp],
      ['sw', swCdp]
    ]) {
      if (!c) {
        errs.push(`${label}: 未连接`);
        continue;
      }
      try {
        return await evaluate(c, REGS_EXPR);
      } catch (e) {
        errs.push(`${label}: ${String((e && e.message) || e)}`);
      }
    }
    throw new Error('无法读取动态注册状态 —— ' + errs.join(' | '));
  }

  /* 5. 打开 harness 页 */
  await cdp.send('Page.navigate', { url: page });
  for (let i = 0; i < 60; i++) {
    const ready = await evaluate(cdp, 'document.readyState').catch(() => '?');
    if (ready === 'complete') break;
    await sleep(150);
  }

  /* 6. 注入是否生效 */
  check('MAIN world 核心已注入', await evaluate(cdp, 'typeof window.__PVG__ === "object"'));
  check('document.hidden === false', await evaluate(cdp, 'document.hidden === false'));
  check("visibilityState === 'visible'", await evaluate(cdp, 'document.visibilityState === "visible"'));
  check('document.hasFocus() === true', await evaluate(cdp, 'document.hasFocus() === true'));
  check('document.wasDiscarded === false', await evaluate(cdp, 'document.wasDiscarded === false'));

  /* 7. 伪装层的自洽性 */
  check(
    'hidden 取值器 toString 原生',
    (await evaluate(
      cdp,
      'Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Document.prototype,"hidden").get)'
    )) === 'function get hidden() { [native code] }',
    await evaluate(cdp, 'Object.getOwnPropertyDescriptor(Document.prototype,"hidden").get.name')
  );
  check(
    'setInterval toString 原生',
    (await evaluate(cdp, 'Function.prototype.toString.call(setInterval)')) ===
      'function setInterval() { [native code] }'
  );
  check(
    'Date toString 原生',
    (await evaluate(cdp, 'Function.prototype.toString.call(Date)')) === 'function Date() { [native code] }'
  );
  check('Object.getPrototypeOf(Date) 正确', await evaluate(cdp, 'Object.getPrototypeOf(Date) === Function.prototype'));
  check('(new Date()).constructor === Date', await evaluate(cdp, '(new Date()).constructor === Date'));
  check(
    'Date 自有属性集合正确',
    (await evaluate(cdp, 'Object.getOwnPropertyNames(Date).join()')) === 'length,name,prototype,now,parse,UTC',
    await evaluate(cdp, 'Object.getOwnPropertyNames(Date).join()')
  );
  check('hasFocus toString 原生', await evaluate(cdp, 'Function.prototype.toString.call(document.hasFocus).includes("[native code]")'));
  check('rAF toString 原生', await evaluate(cdp, 'Function.prototype.toString.call(requestAnimationFrame).includes("[native code]")'));

  /* 8. 时间轴自洽 */
  check(
    'Date.now() 与 timeOrigin+performance.now() 一致',
    near(await evaluate(cdp, 'Date.now() - (performance.timeOrigin + performance.now())'), 0, 5),
    await evaluate(cdp, 'Date.now() - (performance.timeOrigin + performance.now())')
  );
  check('new Date().getTime() ≈ Date.now()', near(await evaluate(cdp, 'new Date().getTime() - Date.now()'), 0, 5));
  check('Date.parse 未被破坏', (await evaluate(cdp, 'Date.parse("2020-01-01T00:00:00Z")')) === 1577836800000);
  check('Date.UTC 未被破坏', (await evaluate(cdp, 'Date.UTC(2020,0,1)')) === 1577836800000);
  check('new Date(0) 未被平移', (await evaluate(cdp, 'new Date(0).getTime()')) === 0);
  check('new Date(y,m,d) 语义正常', (await evaluate(cdp, 'new Date(2020,0,1).getFullYear()')) === 2020);
  check('Date.now() 单调', await evaluate(cdp, '(()=>{let p=Date.now();for(let i=0;i<2000;i++){const n=Date.now();if(n<p)return false;p=n;}return true})()'));

  /* 9. 前台定时器语义 */
  check(
    'setInterval 返回数字 id',
    (await evaluate(cdp, 'typeof setInterval(()=>{},1000)')) === 'number'
  );
  check(
    'clearInterval 生效',
    await evaluate(
      cdp,
      '(()=>{const before=__PVG__.sched.timers.size;const id=setInterval(()=>{},1000);const mid=__PVG__.sched.timers.size;clearInterval(id);return mid===before+1&&__PVG__.sched.timers.size===before})()'
    )
  );
  const timeoutDelta = await evaluate(
    cdp,
    'new Promise(r=>{const t=performance.now();setTimeout(()=>r(performance.now()-t),`40`)})'
  ).catch(() => null);
  check('setTimeout(40) 实际延时合理', near(timeoutDelta, 40, 60), `${timeoutDelta} ms`);
  check(
    'rAF 时间戳与 performance.now() 同轴',
    await evaluate(
      cdp,
      'new Promise(r=>{requestAnimationFrame(t=>r(Math.abs(t-performance.now())<40))})'
    )
  );
  check(
    'setTimeout 传非函数时透传原生',
    (await evaluate(cdp, '(()=>{try{const id=setTimeout("void 0",0);clearTimeout(id);return true}catch(e){return false}})()')) === true
  );

  /* 10. 虚拟调度器:模拟后台 2000ms */
  await evaluate(
    cdp,
    '(()=>{window.__e2e={ticks:[],frames:[],t0:performance.now()};' +
      '__e2e.id=setInterval(()=>__e2e.ticks.push(performance.now()),100);' +
      'const l=()=>{__e2e.frames.push(performance.now());requestAnimationFrame(l)};requestAnimationFrame(l);' +
      '__e2e.r0=__PVG__.clock.realNow();__PVG__.clock.hold();' +
      'return __PVG__.clock.holding})()'
  ).then((v) => check('clock.hold() 进入冻结态', v === true));

  await sleep(2000);

  const pumped = await evaluate(
    cdp,
    '(()=>{const before=performance.now();' +
      '__PVG__.sched.pump(__PVG__.clock.realNow()-__e2e.r0);' +
      'const adv=performance.now()-before;' +
      'const ticks=__e2e.ticks;const gaps=ticks.slice(1).map((v,i)=>v-ticks[i]);' +
      'const monotone=ticks.every((v,i)=>i===0||v>ticks[i-1]);' +
      '/* 再跑一小段,确认 release 前后时钟连续 */' +
      'const p1=performance.now();__PVG__.clock.release();const p2=performance.now();' +
      'clearInterval(__e2e.id);' +
      'return{count:ticks.length,maxGap:gaps.length?Math.max(...gaps):0,' +
      'minGap:gaps.length?Math.min(...gaps):0,monotone:monotone,' +
      'virtualAdvanced:performance.now()-__e2e.t0,frames:__e2e.frames.length,' +
      'frameGap:(__e2e.frames.length>1?(__e2e.frames[__e2e.frames.length-1]-__e2e.frames[0])/(__e2e.frames.length-1):0),' +
      'offsetAfterRelease:__PVG__.clock.offset,holdingAfter:__PVG__.clock.holding,' +
      'jumpAtRelease:Math.abs(p2-p1),adv}})()'
  );

  check('补投递的 interval 次数 ≈ 20', near(pumped.count, 20, 3), `count=${pumped.count}`);
  check('补投递后的时间戳间距 ≈ 100ms', near(pumped.maxGap, 100, 8) && near(pumped.minGap, 100, 8), `min=${pumped.minGap} max=${pumped.maxGap}`);
  check('补投递期间时钟严格单调', pumped.monotone === true);
  check('冻结期间虚拟时间推进 ≈ 2000ms', near(pumped.virtualAdvanced, 2000, 120), `${pumped.virtualAdvanced.toFixed(1)} ms`);
  check('冻结期间帧数 ≈ 120(60fps)', near(pumped.frames, 120, 25), `frames=${pumped.frames}`);
  check('帧时间戳平均间距 ≈ 16.7ms', near(pumped.frameGap, 16.667, 3), `${pumped.frameGap.toFixed(3)} ms`);
  check('release 后不再冻结', pumped.holdingAfter === false);
  check('release 时时钟无跳变', pumped.jumpAtRelease < 30, `${pumped.jumpAtRelease.toFixed(2)} ms`);
  check('release 后残余漂移 < 120ms', Math.abs(pumped.offsetAfterRelease) < 120, `${pumped.offsetAfterRelease.toFixed(1)} ms`);

  /* 11. release 之后时钟继续单调前进 */
  check(
    'release 后时钟继续前进且单调',
    await evaluate(
      cdp,
      'new Promise(r=>{const a=performance.now();setTimeout(()=>{const b=performance.now();r(b>a&&(b-a)>150)},250)})'
    )
  );

  /* 12. harness 自身能跑通且不报错 */
  const harnessRows = await evaluate(
    cdp,
    '(()=>{__PVG_HARNESS__.runInstant();const rs=__PVG_HARNESS__.rows.instant;' +
      'return{total:rs.length,leaks:rs.filter(r=>r.verdict==="leak").map(r=>r.name),' +
      'warns:rs.filter(r=>r.verdict==="warn").map(r=>r.name)}})()'
  );
  check('harness 即时检查产出结果', harnessRows.total > 10, `${harnessRows.total} 项`);
  check('harness 即时检查无 leak', harnessRows.leaks.length === 0, harnessRows.leaks.join(' , '));

  /* 14. 手动武装流程(本次改动的重点) */
  if (optCdp) {
    const initial = await regs();
    check('初始没有任何动态注册(不自动作用于任何站点)', initial.length === 0, JSON.stringify(initial.map((s) => s.id)));

    const armRes = await evaluate(
      optCdp,
      "chrome.runtime.sendMessage({type:'pvg:arm',input:'127.0.0.1',patterns:['http://127.0.0.1/*']})"
    );
    check(
      'pvg:arm 成功',
      !!(armRes && armRes.ok),
      JSON.stringify((armRes && (armRes.error || { reloaded: armRes.reloaded })) || null)
    );

    const after = await regs();
    const mainReg = after.find((s) => s.id === 'pvg-main');
    check('注册出 MAIN world 脚本', !!mainReg && mainReg.world === 'MAIN', JSON.stringify(after.map((s) => s.id)));
    check(
      '注册匹配目标源',
      !!mainReg && (mainReg.matches || []).includes('http://127.0.0.1/*'),
      JSON.stringify(mainReg && mainReg.matches)
    );
    check(
      '注册是会话级 persistAcrossSessions=false',
      !!mainReg && mainReg.persist === false,
      mainReg ? String(mainReg.persist) : 'n/a'
    );
    check('同时注册了 ISOLATED 桥', after.some((s) => s.id === 'pvg-bridge'));

    // 武装会刷新匹配的标签页 -> 等它重载完,顺带验证「静态 + 动态双重注入」下幂等守卫有效
    await sleep(1200);
    let injected = false;
    for (let i = 0; i < 40; i++) {
      injected = await evalRetry(cdp, 'typeof window.__PVG__ === "object"').catch(() => false);
      if (injected === true) break;
      await sleep(250);
    }
    check('武装后页面重新注入', injected === true);

    const dual = await evaluate(
      cdp,
      '(()=>{const d=Object.getOwnPropertyDescriptor(Document.prototype,"hidden");' +
        'return{hidden:document.hidden,focus:document.hasFocus(),' +
        'getterNative:Function.prototype.toString.call(d.get)==="function get hidden() { [native code] }",' +
        'timerNative:Function.prototype.toString.call(setInterval)==="function setInterval() { [native code] }",' +
        'axis:Math.abs(Date.now()-(performance.timeOrigin+performance.now())),' +
        'proto:Object.getPrototypeOf(Date)===Function.prototype,' +
        'ctor:(new Date()).constructor===Date}})()'
    );
    check(
      '双重注入后取值仍正确',
      dual.hidden === false &&
        dual.focus === true &&
        dual.getterNative &&
        dual.timerNative &&
        dual.proto &&
        dual.ctor &&
        dual.axis < 5,
      JSON.stringify(dual)
    );

    // 第三次注入:「仅注入当前页」路径,验证幂等守卫真的挡住了二次包装
    await evaluate(cdp, 'window.__beforeGetter = Object.getOwnPropertyDescriptor(Document.prototype,"hidden").get; true');
    const tabIds = await evaluate(optCdp, "chrome.tabs.query({url:'http://127.0.0.1/*'}).then(ts=>ts.map(t=>t.id))");
    check('定位到被测标签页', Array.isArray(tabIds) && tabIds.length > 0, JSON.stringify(tabIds));
    const inj = await evaluate(optCdp, `chrome.runtime.sendMessage({type:'pvg:injectNow',tabId:${tabIds[0]}})`);
    check('pvg:injectNow 成功', !!(inj && inj.ok), JSON.stringify(inj));
    check(
      '幂等守卫挡住二次包装(取值器身份不变)',
      (await evaluate(
        cdp,
        'Object.getOwnPropertyDescriptor(Document.prototype,"hidden").get === window.__beforeGetter'
      )) === true
    );
    check(
      '三重注入后定时器仍正常',
      (await evaluate(cdp, 'new Promise(r=>{let n=0;const id=setInterval(()=>{n++;if(n>=3){clearInterval(id);r(n)}},30)})')) === 3
    );

    const dis = await evaluate(optCdp, "chrome.runtime.sendMessage({type:'pvg:disarmAll'})");
    check('pvg:disarmAll 成功', !!(dis && dis.ok));
    const finalRegs = await regs();
    check('停止后动态注册已清空', finalRegs.length === 0, JSON.stringify(finalRegs.map((s) => s.id)));
  }

  /* 15. 全程无未捕获异常 */
  const allEvents = [...cdp.events, ...(optCdp ? optCdp.events : [])];
  const exceptions = allEvents.filter((e) => e.method === 'Runtime.exceptionThrown');
  const logErrors = allEvents.filter(
    (e) => e.method === 'Log.entryAdded' && e.params && e.params.entry && e.params.entry.level === 'error'
  );
  check(
    '页面无未捕获异常',
    exceptions.length === 0,
    exceptions
      .slice(0, 3)
      .map((e) => String((e.params.exceptionDetails.exception || {}).description || '').split('\n')[0])
      .join(' | ')
  );
  check(
    '无 console/网络错误',
    logErrors.length === 0,
    logErrors.slice(0, 3).map((e) => e.params.entry.text).join(' | ')
  );

  cdp.close();
} catch (e) {
  check('执行环境', false, String((e && e.message) || e));
} finally {
  if (browser) {
    try {
      browser.kill();
    } catch (_) {}
  }
  if (server) server.close();
  if (tmpRoot) {
    try {
      await rm(tmpRoot, { recursive: true, force: true });
    } catch (_) {}
  }
}

/* -------------------------------------------------------------------- 输出 */

const failed = results.filter((r) => !r.ok);
console.log('');
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
}
console.log('');
if (failed.length) {
  console.log(`  ${failed.length}/${results.length} 项失败\n`);
  process.exitCode = 1;
} else {
  console.log(`  OK  ${results.length}/${results.length} 项通过\n`);
}
