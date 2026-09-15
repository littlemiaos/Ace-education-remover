'use strict';

/*
 * detector.js — PVG 泄漏检测 harness
 *
 * 原则:不用被测的时钟去证明被测的时钟。
 *
 *   - 页面里读到的 performance.now() / Date.now() 都可能被遮蔽,拿它们互相印证毫无意义;
 *   - 本 harness 因此把 Worker 当作「真实时钟仪器」。Worker 是独立 realm,content script
 *     不会注入进去,它的 Date.now() 永远是墙钟时间,它的定时器也只受浏览器调度影响。
 *   - 再加上服务器 Date 头(±1s 分辨率)这一路绝对时间参考,就能把「客户端时间是否
 *     被整体平移过」量出来 —— 而这正是所有时序遮蔽方案最后剩下的破绽。
 *
 * 判定语义:pass = 已经看不出你不在前台;leak = 还能看出来;warn = 可疑/不稳;n/a = 本次不可判定。
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const TARGET_SECS = 15;
  const BASELINE_KEY = 'pvg_harness_baseline_v1';

  const rows = { instant: [], bg: [], clock: [], gap: [] };
  const add = (bucket, row) => {
    rows[bucket].push(row);
    return row;
  };
  const fmt = (v, d = 2) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : String(v));

  const VERDICT_LABEL = { pass: '通过', leak: '可被抓', warn: '可疑', info: '信息', 'n/a': '不判定' };

  /* ---------------------------------------------------------------- 渲染 */

  let baseline = null;
  try {
    baseline = JSON.parse(localStorage.getItem(BASELINE_KEY) || 'null');
  } catch (_) {
    baseline = null;
  }

  const baselineOf = (name) => {
    if (!baseline) return null;
    for (const bucket of ['instant', 'bg', 'clock']) {
      const hit = (baseline[bucket] || []).find((r) => r.name === name);
      if (hit) return hit;
    }
    return null;
  };

  function render(bucket, tbody) {
    tbody.textContent = '';
    for (const r of rows[bucket]) {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.textContent = r.name;

      const tdObs = document.createElement('td');
      tdObs.className = 'mono';
      tdObs.textContent = r.observed;

      const tdExp = document.createElement('td');
      tdExp.className = 'mono dim';
      tdExp.textContent = r.expected;

      const tdVerdict = document.createElement('td');
      const span = document.createElement('span');
      span.className = 'verdict ' + r.verdict;
      span.textContent = VERDICT_LABEL[r.verdict] || r.verdict;
      tdVerdict.append(span);

      const tdNote = document.createElement('td');
      tdNote.className = 'note';
      tdNote.textContent = r.note || '';
      const b = baselineOf(r.name);
      if (b && b.verdict !== r.verdict) {
        const tag = document.createElement('div');
        tag.className = 'note';
        tag.style.marginTop = '2px';
        tag.textContent = `基线:${VERDICT_LABEL[b.verdict] || b.verdict} → 现在:${VERDICT_LABEL[r.verdict] || r.verdict}`;
        tdNote.append(tag);
      }

      tr.append(tdName, tdObs, tdExp, tdVerdict, tdNote);
      tbody.append(tr);
    }
  }

  function metric(k, v, n) {
    const d = document.createElement('div');
    d.className = 'card metric';
    const ek = document.createElement('div');
    ek.className = 'k';
    ek.textContent = k;
    const ev = document.createElement('div');
    ev.className = 'v';
    ev.textContent = v;
    d.append(ek, ev);
    if (n) {
      const en = document.createElement('div');
      en.className = 'n';
      en.textContent = n;
      d.append(en);
    }
    return d;
  }

  function renderSummary() {
    const all = [...rows.instant, ...rows.bg, ...rows.clock];
    const count = (v) => all.filter((r) => r.verdict === v).length;
    const leaks = all.filter((r) => r.verdict === 'leak');
    const box = $('summary');
    box.textContent = '';

    const head = document.createElement('div');
    head.style.fontSize = '15px';
    head.style.marginBottom = '8px';
    if (leaks.length === 0) {
      head.textContent = `未发现可被抓的项(通过 ${count('pass')} · 可疑 ${count('warn')} · 不判定 ${count('n/a')})。`;
      head.style.color = 'var(--ok)';
    } else {
      head.textContent = `仍有 ${leaks.length} 项可被抓(通过 ${count('pass')} · 可疑 ${count('warn')})。`;
      head.style.color = 'var(--bad)';
    }
    box.append(head);

    if (leaks.length) {
      const ul = document.createElement('ul');
      ul.className = 'plain';
      for (const r of leaks) {
        const li = document.createElement('li');
        li.textContent = `${r.name}:${r.observed}${r.note ? ' —— ' + r.note : ''}`;
        ul.append(li);
      }
      box.append(ul);
    }

    const tail = document.createElement('div');
    tail.className = 'note';
    tail.style.marginTop = '10px';
    tail.textContent =
      '提醒:「通过」只代表本次测量没抓到。任何客户端遮蔽都躲不过一个我们没接管的时钟,判定面的清单见上一节。';
    box.append(tail);
  }

  /* --------------------------------------------------- 跨 realm 取值探针 */

  function childState() {
    const out = { hidden: null, state: null, date: null, err: null, patched: null };
    try {
      const w = $('childBlank').contentWindow;
      if (!w) return out;
      out.hidden = w.document.hidden;
      out.state = w.document.visibilityState;
      out.date = w.Date.now();
      out.patched = typeof w.__PVG__ !== 'undefined';
    } catch (e) {
      out.err = String((e && e.message) || e);
    }
    return out;
  }

  /* --------------------------------------------------------- 即时检查 */

  function runInstant() {
    rows.instant = [];

    const hiddenDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    const stateDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    const hasFocusDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hasFocus');
    const push = (name, observed, expected, verdict, note) =>
      add('instant', { name, observed, expected, verdict, note });

    /* --- 状态取值 --- */
    push('document.hidden', String(document.hidden), 'false', document.hidden === false ? 'pass' : 'leak', '');
    push(
      'document.visibilityState',
      JSON.stringify(document.visibilityState),
      "'visible'",
      document.visibilityState === 'visible' ? 'pass' : 'leak',
      ''
    );
    push(
      'document.webkitHidden',
      String(document.webkitHidden),
      'false',
      document.webkitHidden === false ? 'pass' : 'leak',
      '老检测路径,仍在被使用'
    );
    push('document.hasFocus()', String(document.hasFocus()), 'true', document.hasFocus() === true ? 'pass' : 'leak', '');
    push(
      'document.wasDiscarded',
      String(document.wasDiscarded),
      'false',
      document.wasDiscarded === false ? 'pass' : 'warn',
      '为 true 表示标签页曾被回收过'
    );

    /* --- 补丁自身的可指纹化程度 --- */
    const getterSrc = hiddenDesc && hiddenDesc.get ? Function.prototype.toString.call(hiddenDesc.get) : '(无描述符)';
    push(
      'toString(document.hidden 取值器)',
      getterSrc.length > 70 ? getterSrc.slice(0, 67) + '…' : getterSrc,
      'function get hidden() { [native code] }',
      getterSrc === 'function get hidden() { [native code] }' ? 'pass' : /\[native code\]/.test(getterSrc) ? 'warn' : 'leak',
      '不含 [native code] 即说明取值器被换过'
    );
    push(
      '取值器的 name / length',
      `${hiddenDesc && hiddenDesc.get ? hiddenDesc.get.name : '?'} / ${hiddenDesc && hiddenDesc.get ? hiddenDesc.get.length : '?'}`,
      'hidden / 0',
      hiddenDesc && hiddenDesc.get && hiddenDesc.get.name === 'hidden' && hiddenDesc.get.length === 0 ? 'pass' : 'warn',
      ''
    );
    push(
      'document.hidden 描述符标志',
      hiddenDesc ? `enumerable=${hiddenDesc.enumerable} configurable=${hiddenDesc.configurable}` : '(无)',
      'enumerable=true configurable=true',
      hiddenDesc && hiddenDesc.enumerable === true && hiddenDesc.configurable === true ? 'pass' : 'warn',
      ''
    );
    const hfSrc = hasFocusDesc && hasFocusDesc.value ? Function.prototype.toString.call(hasFocusDesc.value) : '(无)';
    push(
      'toString(document.hasFocus)',
      hfSrc.length > 70 ? hfSrc.slice(0, 67) + '…' : hfSrc,
      'function hasFocus() { [native code] }',
      /\[native code\]/.test(hfSrc) ? 'pass' : 'leak',
      ''
    );
    const siSrc = Function.prototype.toString.call(setInterval);
    push(
      'toString(setInterval)',
      siSrc.length > 70 ? siSrc.slice(0, 67) + '…' : siSrc,
      'function setInterval() { [native code] }',
      /\[native code\]/.test(siSrc) ? 'pass' : 'leak',
      '定时器被换成 JS 实现时这里会露出源码'
    );
    const rafSrc = Function.prototype.toString.call(requestAnimationFrame);
    push(
      'toString(requestAnimationFrame)',
      rafSrc.length > 70 ? rafSrc.slice(0, 67) + '…' : rafSrc,
      'function requestAnimationFrame() { [native code] }',
      /\[native code\]/.test(rafSrc) ? 'pass' : 'leak',
      ''
    );

    /* --- 时间轴的内部自洽性 --- */
    const dNow = Date.now();
    const derived = performance.timeOrigin + performance.now();
    const axisDelta = Math.abs(dNow - derived);
    push(
      'Date.now() 与 timeOrigin+performance.now() 的差',
      fmt(axisDelta, 2) + ' ms',
      '≈ 0',
      axisDelta < 20 ? 'pass' : 'leak',
      '两条时间轴必须严格自洽,否则一眼假'
    );
    const ctorOk = new Date().constructor === Date;
    push('(new Date()).constructor === Date', String(ctorOk), 'true', ctorOk ? 'pass' : 'leak', '');
    const protoOk = Object.getPrototypeOf(Date) === Function.prototype;
    push(
      'Object.getPrototypeOf(Date)',
      protoOk ? 'Function.prototype' : String(Object.getPrototypeOf(Date)),
      'Function.prototype',
      protoOk ? 'pass' : 'leak',
      '内建构造器被换成普通函数时,这一项会变成某个 Date 函数'
    );
    const ownNames = Object.getOwnPropertyNames(Date).join(',');
    push(
      'Object.getOwnPropertyNames(Date)',
      ownNames,
      'length,name,prototype,now,parse,UTC',
      ownNames === 'length,name,prototype,now,parse,UTC' ? 'pass' : 'warn',
      ''
    );
    const dateSrc = Function.prototype.toString.call(Date);
    push(
      'toString(Date)',
      dateSrc.length > 70 ? dateSrc.slice(0, 67) + '…' : dateSrc,
      'function Date() { [native code] }',
      /\[native code\]/.test(dateSrc) ? 'pass' : 'leak',
      ''
    );

    /* --- 扩展自身留下的痕迹 --- */
    const pvgPresent = typeof window.__PVG__ !== 'undefined';
    push(
      'window.__PVG__ 是否可被页面读到',
      String(pvgPresent),
      '(遮蔽工具自身不留痕)',
      pvgPresent ? 'warn' : 'pass',
      pvgPresent
        ? 'MAIN world 注入必然在页面全局留下痕迹,这是本方案自身的指纹。可改为每会话随机属性名或用 Symbol 缓解,但无法根除。'
        : ''
    );

    /* --- 跨 realm --- */
    const child = childState();
    if (child.err) {
      push('子框架(about:blank)取值', '不可读:' + child.err, '与主框架一致', 'n/a', '');
    } else {
      push(
        '子框架(about:blank)是否已被注入',
        child.patched ? '是' : '否',
        '是',
        child.patched ? 'pass' : 'warn',
        '未注入的子框架会直接返回真实的 visibilityState,后台测量阶段会抓到'
      );
      const sameAxis = Math.abs(child.date - Date.now()) < 50;
      push(
        '子框架 Date.now() 与主框架的差',
        fmt(Math.abs(child.date - Date.now()), 1) + ' ms',
        '≈ 0',
        sameAxis ? 'pass' : 'warn',
        '跨 realm 的时钟若不同步,组合读数就能反推遮蔽'
      );
    }

    render('instant', $('instantBody'));
    renderSummary();
  }

  /* --------------------------------------------------------- 后台测量 */

  const BG = {
    running: false,
    t0: 0,
    t0Perf: 0,
    t0Timeline: null,
    ticks: [],
    frames: [],
    events: {},
    workerSamples: [],
    rIC: 0,
    worker: null,
    workerError: null,
    intervalId: null,
    uiTimer: null,
    serverT0: null,
    childErr: null
  };

  const EVENT_TARGETS = {
    visibilitychange: document,
    freeze: document,
    resume: document,
    blur: window,
    focus: window,
    pagehide: window,
    pageshow: window
  };

  const lastWorkerIdx = () => BG.workerSamples.length - 1;

  function realElapsedMs() {
    const ws = BG.workerSamples;
    return ws.length > 1 ? ws[ws.length - 1].real - ws[0].real : NaN;
  }

  function sampleTick() {
    const child = childState();
    BG.ticks.push({
      v: performance.now(),
      d: Date.now(),
      hidden: document.hidden,
      state: document.visibilityState,
      focus: document.hasFocus(),
      childHidden: child.hidden,
      childState: child.state,
      timeline: document.timeline ? document.timeline.currentTime : null
    });
  }

  function startWorker() {
    try {
      const src =
        'let n=0;function loop(){n++;self.postMessage({real:Date.now(),perf:performance.now(),n:n});setTimeout(loop,4);}loop();';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      BG.worker = new Worker(url);
      BG.worker.onmessage = (e) => BG.workerSamples.push(e.data);
    } catch (e) {
      BG.workerError = String((e && e.message) || e);
    }
  }

  async function fetchServerTime() {
    try {
      const res = await fetch(location.href, { method: 'HEAD', cache: 'no-store' });
      const h = res.headers.get('date');
      if (!h) return null;
      const t = Date.parse(h);
      return isFinite(t) ? t : null;
    } catch (_) {
      return null;
    }
  }

  async function startBg() {
    resetBg();
    BG.running = true;
    BG.t0 = Date.now();
    BG.t0Perf = performance.now();
    BG.t0Timeline = document.timeline ? document.timeline.currentTime : null;
    BG.serverT0 = await fetchServerTime();

    startWorker();

    for (const [type, target] of Object.entries(EVENT_TARGETS)) {
      BG.events[type] = 0;
      target.addEventListener(type, () => {
        BG.events[type]++;
      }, true);
    }

    sampleTick();
    BG.intervalId = setInterval(sampleTick, 200);

    const loop = () => {
      if (!BG.running) return;
      BG.frames.push({ v: performance.now(), wid: lastWorkerIdx() });
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);

    if (window.requestIdleCallback) {
      const ricLoop = () => {
        if (!BG.running) return;
        BG.rIC++;
        requestIdleCallback(ricLoop);
      };
      requestIdleCallback(ricLoop);
    }

    BG.uiTimer = setInterval(paintRunner, 200);

    $('startBg').disabled = true;
    $('finishBg').disabled = false;
    $('bgRunner').classList.remove('hidden');
    $('bgState').textContent = '测量中 —— 现在切走';
    paintRunner();
  }

  function paintRunner() {
    const el = realElapsedMs();
    $('countdown').textContent = isFinite(el) ? (el / 1000).toFixed(1) + ' s' : '—';
    if (isFinite(el)) {
      $('bgBar').style.width = Math.min(100, (el / (TARGET_SECS * 1000)) * 100) + '%';
    }
  }

  function resetBg() {
    if (BG.worker) BG.worker.terminate();
    if (BG.intervalId !== null) clearInterval(BG.intervalId);
    if (BG.uiTimer !== null) clearInterval(BG.uiTimer);
    BG.worker = null;
    BG.intervalId = null;
    BG.uiTimer = null;
    BG.ticks = [];
    BG.frames = [];
    BG.workerSamples = [];
    BG.events = {};
    BG.rIC = 0;
    BG.workerError = null;
    BG.serverT0 = null;
    $('bgMetrics').textContent = '';
    $('bgTable').classList.add('hidden');
  }

  const median = (arr) => {
    if (!arr.length) return NaN;
    const s = arr.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  async function finishBg() {
    if (!BG.running) return;
    const t1 = Date.now();
    const t1Perf = performance.now();
    const t1Timeline = document.timeline ? document.timeline.currentTime : null;
    const serverT1 = await fetchServerTime();

    BG.running = false;
    if (BG.intervalId !== null) clearInterval(BG.intervalId);
    if (BG.uiTimer !== null) clearInterval(BG.uiTimer);
    if (BG.worker) BG.worker.terminate();

    $('finishBg').disabled = true;
    $('startBg').disabled = false;
    $('bgState').textContent = '已完成';

    computeBg(t1, t1Perf, t1Timeline, serverT1);
    render('bg', $('bgBody'));
    render('clock', $('clockBody'));
    renderGaps();
    renderSummary();
  }

  function computeBg(t1, t1Perf, t1Timeline, serverT1) {
    rows.bg = [];
    rows.clock = [];
    const push = (name, observed, expected, verdict, note) =>
      add('bg', { name, observed, expected, verdict, note });
    const pushClock = (name, observed, expected, verdict, note) =>
      add('clock', { name, observed, expected, verdict, note });

    const ws = BG.workerSamples;
    const workerElapsed = realElapsedMs();
    const mainElapsed = t1 - BG.t0;
    const perfElapsed = t1Perf - BG.t0Perf;
    const drift = isFinite(workerElapsed) ? workerElapsed - mainElapsed : NaN;
    const enough = isFinite(workerElapsed) && workerElapsed >= 3000;
    const shortNote = '离开时间不足 3s,本次不可判定';

    /* --- 度量卡片 --- */
    const mg = $('bgMetrics');
    mg.textContent = '';
    mg.append(
      metric('真实离开时长', isFinite(workerElapsed) ? fmt(workerElapsed / 1000, 2) + ' s' : 'n/a', 'Worker 时钟,不受遮蔽影响'),
      metric('页面虚拟经过时长', fmt(mainElapsed / 1000, 2) + ' s', 'Date.now() 口径'),
      metric('时钟漂移', isFinite(drift) ? fmt(drift, 0) + ' ms' : 'n/a', '真实 − 虚拟;理想值 0'),
      metric('interval 回调次数', String(Math.max(0, BG.ticks.length - 1)), '期望 ≈ ' + (isFinite(workerElapsed) ? Math.round(workerElapsed / 200) : '?')),
      metric('rAF 帧数', String(BG.frames.length), '期望 ≈ ' + (isFinite(workerElapsed) ? Math.round(workerElapsed / 16.67) : '?')),
      metric('Worker 采样数', String(ws.length), ws.length > 1 ? '中位间隔 ' + fmt(median(ws.slice(1).map((s, i) => s.real - ws[i].real)), 1) + ' ms' : BG.workerError || '')
    );

    /* --- 页面是否观测到离开 --- */
    const evTotal = Object.values(BG.events).reduce((a, b) => a + b, 0);
    const evDetail = Object.entries(BG.events)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    push(
      '页面收到的前台/后台事件总数',
      String(evTotal),
      '0',
      !enough ? 'n/a' : evTotal === 0 ? 'pass' : 'leak',
      !enough ? shortNote : evDetail
    );

    /* --- 状态快照 --- */
    const ticks = BG.ticks;
    const hiddenHits = ticks.filter((t) => t.hidden === true).length;
    const stateHits = ticks.filter((t) => t.state !== 'visible').length;
    const focusHits = ticks.filter((t) => t.focus === false).length;
    push(
      '采样到 document.hidden === true',
      `${hiddenHits} / ${ticks.length}`,
      '0',
      !enough ? 'n/a' : hiddenHits === 0 ? 'pass' : 'leak',
      !enough ? shortNote : '每 200ms 采样一次'
    );
    push(
      "采样到 visibilityState !== 'visible'",
      `${stateHits} / ${ticks.length}`,
      '0',
      !enough ? 'n/a' : stateHits === 0 ? 'pass' : 'leak',
      ''
    );
    push(
      '采样到 hasFocus() === false',
      `${focusHits} / ${ticks.length}`,
      '0',
      !enough ? 'n/a' : focusHits === 0 ? 'pass' : 'leak',
      ''
    );

    /* --- 跨 realm --- */
    const childReadable = ticks.some((t) => t.childHidden !== null);
    const childHits = ticks.filter((t) => t.childHidden === true || (t.childState && t.childState !== 'visible')).length;
    push(
      '子框架(about:blank)泄漏真实状态的次数',
      childReadable ? `${childHits} / ${ticks.length}` : '不可读',
      '0',
      !childReadable ? 'n/a' : !enough ? 'n/a' : childHits === 0 ? 'pass' : 'leak',
      '跨 realm 是最容易被忽略的一路:父页面可以直接读子框架的 document'
    );

    /* --- interval 节奏 --- */
    const vTimes = ticks.map((t) => t.v);
    const gaps = vTimes.slice(1).map((v, i) => v - vTimes[i]);
    const maxGap = gaps.length ? Math.max(...gaps) : NaN;
    push(
      'interval(200ms) 最大间隔(虚拟时钟口径)',
      isFinite(maxGap) ? fmt(maxGap, 0) + ' ms' : 'n/a',
      '≈ 200 ms',
      !enough ? 'n/a' : !isFinite(maxGap) ? 'n/a' : maxGap > 600 ? 'leak' : maxGap > 300 ? 'warn' : 'pass',
      '基线(off)在后台会是 1000ms 量级甚至更长'
    );
    const expTicks = isFinite(workerElapsed) ? workerElapsed / 200 : NaN;
    const tickRatio = isFinite(expTicks) && expTicks > 0 ? ticks.length / expTicks : NaN;
    push(
      'interval 回调次数 / 期望次数',
      isFinite(tickRatio) ? fmt(tickRatio, 2) : 'n/a',
      '≥ 0.9',
      !enough ? 'n/a' : !isFinite(tickRatio) ? 'n/a' : tickRatio < 0.5 ? 'leak' : tickRatio < 0.8 ? 'warn' : 'pass',
      '次数不足说明补投递没生效,只有时间戳被改过'
    );

    /* --- rAF 节奏 --- */
    const expFrames = isFinite(workerElapsed) ? workerElapsed / 16.667 : NaN;
    const frameRatio = isFinite(expFrames) && expFrames > 0 ? BG.frames.length / expFrames : NaN;
    push(
      'rAF 帧数 / 期望帧数',
      `${BG.frames.length} / ${isFinite(expFrames) ? Math.round(expFrames) : '?'}`,
      '≥ 0.8',
      !enough ? 'n/a' : BG.frames.length === 0 ? 'leak' : !isFinite(frameRatio) ? 'n/a' : frameRatio < 0.3 ? 'leak' : frameRatio < 0.7 ? 'warn' : 'pass',
      '原生 rAF 在后台完全停摆,帧数为 0 是最直白的判定'
    );
    const fv = BG.frames.map((f) => f.v);
    const fgaps = fv.slice(1).map((v, i) => v - fv[i]);
    const medFrameGap = median(fgaps);
    push(
      'rAF 时间戳中位间隔',
      isFinite(medFrameGap) ? fmt(medFrameGap, 2) + ' ms' : 'n/a',
      '≈ 16.67 ms',
      !enough ? 'n/a' : !isFinite(medFrameGap) ? 'n/a' : medFrameGap > 50 ? 'leak' : medFrameGap > 25 ? 'warn' : 'pass',
      ''
    );

    /* --- 补投递突发(本方案唯一的原理性破绽) --- */
    let maxPerSample = 0;
    const perSample = new Map();
    for (const f of BG.frames) {
      const k = f.wid;
      perSample.set(k, (perSample.get(k) || 0) + 1);
    }
    for (const v of perSample.values()) maxPerSample = Math.max(maxPerSample, v);
    const sampleGapMed = ws.length > 1 ? median(ws.slice(1).map((s, i) => s.real - ws[i].real)) : NaN;
    const burstJudged = ws.length >= 20 && isFinite(sampleGapMed);
    push(
      '单个 Worker 采样窗口内的最大帧数',
      burstJudged ? `${maxPerSample}(窗口 ≈ ${fmt(sampleGapMed, 1)} ms)` : 'n/a',
      '≤ 5',
      !burstJudged ? 'n/a' : maxPerSample >= 30 ? 'leak' : maxPerSample >= 8 ? 'warn' : 'pass',
      '补投递是成批发生的:帧被一次性灌进来,而 Worker 的真实时钟分得清「一帧一帧」和「一次灌 60 帧」。这是 replay 策略无法消除的破绽。'
    );

    /* --- 独立时钟 --- */
    pushClock(
      'Worker 时钟(真实经过时间 − 页面虚拟经过时间)',
      isFinite(drift) ? fmt(drift, 0) + ' ms' : 'n/a',
      '|差| < 500 ms',
      !enough ? 'n/a' : !isFinite(drift) ? 'n/a' : Math.abs(drift) < 500 ? 'pass' : Math.abs(drift) < 3000 ? 'warn' : 'leak',
      'freeze 策略在这里必然全线暴露:后台时长 = 漂移量'
    );
    if (serverT1 !== null && BG.serverT0 !== null) {
      const offset = serverT1 - t1;
      pushClock(
        '服务器 Date 头 − 客户端 Date.now()',
        fmt(offset, 0) + ' ms(±1s)',
        '|差| < 2000 ms',
        Math.abs(offset) < 2000 ? 'pass' : Math.abs(offset) < 5000 ? 'warn' : 'leak',
        'HTTP Date 只有秒级分辨率。这是最容易被真实站点利用的一路:任何跨会话时长比对都能发现客户端时间被平移过。'
      );
    } else {
      pushClock('服务器 Date 头 − 客户端 Date.now()', '不可用', '|差| < 2000 ms', 'n/a', '需要通过 HTTP 打开本页(file:// 下无法读 Date 头)');
    }
    if (BG.t0Timeline !== null && t1Timeline !== null) {
      const tlDelta = t1Timeline - BG.t0Timeline;
      const ratio = mainElapsed > 0 ? tlDelta / mainElapsed : NaN;
      pushClock(
        'document.timeline 推进量 / 页面虚拟经过时长',
        isFinite(ratio) ? fmt(ratio, 2) : 'n/a',
        '≈ 1',
        !enough ? 'n/a' : !isFinite(ratio) ? 'n/a' : ratio < 0.2 ? 'leak' : ratio < 0.8 ? 'warn' : 'pass',
        'document.timeline / Animation.currentTime 是独立于 rAF 的时间轴,本实现未接管'
      );
    } else {
      pushClock('document.timeline 推进量', '不可用', '≈ 1', 'n/a', '');
    }
    const expRafLike = isFinite(workerElapsed) ? workerElapsed / 60 : NaN;
    pushClock(
      'requestIdleCallback 回调次数',
      String(BG.rIC),
      isFinite(expRafLike) ? '≳ ' + Math.max(1, Math.round(expRafLike * 0.1)) : '—',
      !enough ? 'n/a' : BG.rIC === 0 ? 'leak' : 'warn',
      '未打补丁:原生 rIC 在后台基本不触发,与「帧还在跑」的状态自相矛盾'
    );

    /* --- 缺口表的实测标记 --- */
    GAP_MEASURED.worker = isFinite(drift) ? Math.abs(drift) < 3000 : null;
    GAP_MEASURED.server = serverT1 !== null && BG.serverT0 !== null ? Math.abs(serverT1 - t1) < 5000 : null;
    GAP_MEASURED.timeline =
      BG.t0Timeline !== null && t1Timeline !== null && mainElapsed > 0
        ? (t1Timeline - BG.t0Timeline) / mainElapsed > 0.5
        : null;
    GAP_MEASURED.ric = enough ? BG.rIC > 0 : null;
    GAP_MEASURED.burst = burstJudged ? maxPerSample < 8 : null;
  }

  /* ----------------------------------------------------------- 缺口表 */

  const GAP_MEASURED = { worker: null, server: null, timeline: null, ric: null, burst: null };

  const GAPS = [
    ['Worker / SharedWorker 里的时钟', 'worker', 'Worker 是独立 realm,不会被注入。它的 Date.now()、performance.now()、定时器节奏都是真实的 —— 也是本 harness 的测量基准。缓解:拦截 Worker 构造并把补丁注入 blob/同源脚本,但会被 CSP(worker-src)挡住,且跨源 Worker 无法处理。'],
    ['服务器时间 / 跨会话时长比对', 'server', '服务端知道你在什么时候发过请求。只要它把客户端上报的时长和自己记录的时间做差,就能算出「你这段时间没在前台」。客户端无法缓解。'],
    ['document.timeline / Animation.currentTime', 'timeline', '渲染引擎的时间轴,与 rAF 是两条线。本实现只改了 rAF,没改这条。'],
    ['requestIdleCallback', 'ric', '未打补丁。后台里原生 rIC 基本不触发,却同时「有帧在跑」,自相矛盾。'],
    ['补投递的成批特征', 'burst', 'replay 策略把欠下的回调一次性补齐,Worker 的真实时钟能分辨「逐帧」与「一次灌 60 帧」。这是原理性破绽,只能靠降低单次预算来减轻。'],
    ['AudioContext.currentTime', null, '另一路跑真实时间的时钟。本次未测:创建一个 running 的 AudioContext 会让 Chrome 把标签页当作「正在播放音频」从而放宽限流,反而让后台测量失去意义。真实站点用过这一招。'],
    ['WebSocket / EventSource 消息到达时间', null, '消息由服务端按真实时间推送,主线程的接收节奏不受可见性影响。未测。'],
    ['CSS :focus / :focus-within / :hover', null, '由渲染引擎判定,JS 层无法改写。用 matches(\':focus-within\') 就能绕过 hasFocus()。'],
    ['窗口几何 screenX / screenY / outerWidth', null, '切窗口时窗口坐标变化。本实现未处理。'],
    ['真实输入事件(isTrusted / userActivation)', null, '页面可以要求「有真实鼠标/键盘事件才算在场」,遮蔽可见性并不能伪造输入。'],
    ['MAIN world 注入的全局痕迹', 'instant', '本方案自己在页面全局留下了 window.__PVG__。站点可以直接枚举 window 属性发现遮蔽工具。缓解:每会话随机属性名或改用 Symbol,无法根除。']
  ];

  function renderGaps() {
    const tbody = $('gapBody');
    tbody.textContent = '';
    for (const [name, key, note] of GAPS) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.textContent = name;
      const td2 = document.createElement('td');
      let flag = null;
      if (key === 'instant') flag = typeof window.__PVG__ !== 'undefined' ? false : true;
      else if (key) flag = GAP_MEASURED[key];
      const span = document.createElement('span');
      span.className = 'verdict ' + (flag === null ? 'info' : flag ? 'pass' : 'leak');
      span.textContent = flag === null ? '未测量' : flag ? '未被抓' : '可被抓';
      td2.append(span);
      const td3 = document.createElement('td');
      td3.className = 'note';
      td3.textContent = note;
      tr.append(td1, td2, td3);
      tbody.append(tr);
    }
  }

  /* --------------------------------------------------------- 基线管理 */

  function updateBaselineState() {
    const n = baseline ? ['instant', 'bg', 'clock'].reduce((a, b) => a + ((baseline[b] || []).length), 0) : 0;
    $('baselineState').textContent = baseline
      ? `已保存基线(${n} 项,${new Date(baseline.at).toLocaleString()})`
      : '无基线';
  }

  /* --------------------------------------------------------------- 接线 */

  // 编程入口:便于用 CDP / 自动化脚本驱动同一套检查,不必点按钮
  window.__PVG_HARNESS__ = {
    runInstant,
    startBg,
    finishBg,
    rows,
    bg: BG,
    gaps: () => GAPS.map(([name, key, note]) => ({ name, measured: key ? GAP_MEASURED[key] : null, note }))
  };

  document.addEventListener('DOMContentLoaded', () => {
    $('targetSecs').textContent = String(TARGET_SECS);
    $('runInstant').addEventListener('click', runInstant);
    $('startBg').addEventListener('click', startBg);
    $('finishBg').addEventListener('click', finishBg);

    $('saveBaseline').addEventListener('click', () => {
      baseline = { at: Date.now(), instant: rows.instant, bg: rows.bg, clock: rows.clock };
      localStorage.setItem(BASELINE_KEY, JSON.stringify(baseline));
      updateBaselineState();
      render('instant', $('instantBody'));
      render('bg', $('bgBody'));
      render('clock', $('clockBody'));
    });
    $('clearBaseline').addEventListener('click', () => {
      localStorage.removeItem(BASELINE_KEY);
      baseline = null;
      updateBaselineState();
      runInstant();
      render('bg', $('bgBody'));
      render('clock', $('clockBody'));
    });

    updateBaselineState();
    runInstant();
    renderGaps();
  });
})();
