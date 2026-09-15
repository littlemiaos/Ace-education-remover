'use strict';

/*
 * 41-timing-sched.js — 时序遮蔽第二层:虚拟调度器 + pump
 *
 * 前台:setTimeout / setInterval 完全交给原生定时器,行为与未打补丁一致。
 * 后台:Chrome 会限流(先是 1s 下限,隐藏超过 5 分钟后可能变成每分钟一次唤醒)。
 *       pump 在每个唤醒点做两件事:
 *         1. 按「本应在虚拟时间轴上到期的时刻」逐个补投递欠下的回调;
 *         2. 把虚拟时钟推进到这些到期时刻(clock.advance)。
 *       结果是页面看到 interval 每 interval 毫秒回调一次、回调内读到的时间戳间距正常,
 *       而不是「我的 1s 定时器 60s 才响一次」。
 *
 * 每个 pump 周期按 16.67ms 切成虚拟时间片,片内先按到期顺序跑定时器,再跑一帧动画
 * (见 42),这样定时器与 rAF 的相对顺序在虚拟时间轴上也说得通。
 *
 * 预算:每次 pump 最多推进 maxVirtualMsPerPump 的虚拟时间、补投递
 *      maxCallbacksPerPump 个回调。超出预算的部分会变成时钟漂移 —— 这是这套方案
 *      唯一无法既省 CPU 又完全隐身的取舍,harness 会把它量出来。
 */

(() => {
  const P = globalThis.__PVG__;
  if (!P) return;
  if (P.sched || !P.clock) return;
  const { natives, disguise } = P;
  const clock = P.clock;

  const DEFAULTS = {
    maxVirtualMsPerPump: 65000,
    maxCallbacksPerPump: 4000,
    minReplayIntervalMs: 20,
    frameIntervalMs: 1000 / 60
  };
  const opts = () => Object.assign({}, DEFAULTS, P.getOptions() || {});

  const timers = new Map(); // id -> { id, cb, args, interval, due, nativeId }
  let nextId = 1;
  let pumping = false;
  let pumpReal = null;
  let lastPumpReal = 0;

  const invoke = (rec) => {
    try {
      rec.cb.apply(globalThis, rec.args);
    } catch (e) {
      P.rethrow(e);
    }
  };

  /** 挂一个原生定时器:它同时是「真实定时器」和后台时的唤醒源 */
  function armNative(rec, delay) {
    const fire = () => {
      rec.nativeId = null;
      if (!timers.has(rec.id)) return;
      if (clock.holding) return; // 后台由 pump 负责,忽略被限流的原生唤醒
      if (rec.interval == null) timers.delete(rec.id);
      else rec.due = clock.now() + rec.interval;
      invoke(rec);
    };
    rec.nativeId =
      rec.interval == null
        ? natives.setTimeout.call(globalThis, fire, delay)
        : natives.setInterval.call(globalThis, fire, rec.interval);
  }

  function schedule(cb, delay, args, repeating) {
    const d = Number(delay);
    const delayMs = isFinite(d) && d > 0 ? d : 0;
    const rec = {
      id: nextId++,
      cb,
      args,
      interval: repeating ? delayMs : null,
      due: clock.now() + delayMs,
      nativeId: null
    };
    timers.set(rec.id, rec);
    armNative(rec, delayMs);
    return rec.id;
  }

  function clearTimer(id) {
    const rec = timers.get(id);
    if (!rec) return false;
    timers.delete(id);
    if (rec.nativeId !== null) {
      if (rec.interval == null) natives.clearTimeout.call(globalThis, rec.nativeId);
      else natives.clearInterval.call(globalThis, rec.nativeId);
      rec.nativeId = null;
    }
    return true;
  }

  /* --------------------------------------------------------- 全局替换 */

  P.replaceMethod(
    globalThis,
    'setTimeout',
    function setTimeout(cb, delay, ...args) {
      if (!P.isOn() || typeof cb !== 'function') {
        return natives.apply(natives.setTimeout, globalThis, arguments);
      }
      return schedule(cb, arguments.length > 1 ? delay : 0, args, false);
    },
    'setTimeout',
    2
  );

  P.replaceMethod(
    globalThis,
    'setInterval',
    function setInterval(cb, delay, ...args) {
      if (!P.isOn() || typeof cb !== 'function') {
        return natives.apply(natives.setInterval, globalThis, arguments);
      }
      return schedule(cb, arguments.length > 1 ? delay : 0, args, true);
    },
    'setInterval',
    2
  );

  P.replaceMethod(
    globalThis,
    'clearTimeout',
    function clearTimeout(id) {
      if (typeof id === 'number' && clearTimer(id)) return undefined;
      return natives.apply(natives.clearTimeout, globalThis, arguments);
    },
    'clearTimeout',
    1
  );

  P.replaceMethod(
    globalThis,
    'clearInterval',
    function clearInterval(id) {
      if (typeof id === 'number' && clearTimer(id)) return undefined;
      return natives.apply(natives.clearInterval, globalThis, arguments);
    },
    'clearInterval',
    1
  );

  /* ------------------------------------------------------------- pump */

  function earliestDue(limit) {
    let best = null;
    for (const rec of timers.values()) {
      if (rec.due > limit) continue;
      if (!best || rec.due < best.due) best = rec;
    }
    return best;
  }

  function pump(maxVirtual) {
    if (pumping || !clock.holding || !(maxVirtual > 0)) return;
    pumping = true;
    try {
      const o = opts();
      const budget = Math.min(maxVirtual, o.maxVirtualMsPerPump);
      const target = clock.now() + budget;
      const frame = Math.max(1, o.frameIntervalMs);
      let fired = 0;

      while (clock.now() < target && fired < o.maxCallbacksPerPump) {
        const sliceEnd = Math.min(clock.now() + frame, target);

        // 本时间片内到期的定时器,按到期时刻顺序补投递
        for (;;) {
          const rec = earliestDue(sliceEnd);
          if (!rec || fired >= o.maxCallbacksPerPump) break;
          const lead = rec.due - clock.now();
          if (lead > 0) clock.advance(lead);
          if (rec.interval == null) {
            timers.delete(rec.id);
          } else if (rec.interval < o.minReplayIntervalMs) {
            rec.due = sliceEnd; // 高频计时器:每个时间片最多补一次,避免百万级回调
          } else {
            rec.due += rec.interval;
          }
          fired++;
          invoke(rec);
        }

        if (clock.now() < sliceEnd) clock.advance(sliceEnd - clock.now());

        // 每个虚拟时间片跑一帧,让 rAF 的密度也维持在 60/s
        const sources = P.frameSources;
        for (let i = 0; i < sources.length; i++) {
          try {
            sources[i](clock.now());
          } catch (e) {
            P.log(e);
          }
        }
      }

      if (clock.now() < target) clock.advance(target - clock.now());
    } finally {
      pumping = false;
    }
  }

  function startPump() {
    if (pumpReal !== null) return;
    const tick = () => {
      pumpReal = null;
      if (!clock.holding) return;
      const r = clock.realNow();
      const elapsed = r - lastPumpReal;
      lastPumpReal = r;
      pump(elapsed);
      if (clock.holding) startPump();
    };
    // 后台里这个 1000ms 会被浏览器限流(可能变成 1 分钟一次);
    // 醒来后用真实经过时间一次性补齐即可,不影响正确性。
    pumpReal = natives.setTimeout.call(globalThis, tick, 1000);
  }

  function stopPump() {
    if (pumpReal !== null) {
      natives.clearTimeout.call(globalThis, pumpReal);
      pumpReal = null;
    }
  }

  /* ------------------------------------------------------------- 接线 */

  P.onHiddenChange((hidden) => {
    if (!P.isOn()) return;
    if (hidden) {
      lastPumpReal = clock.realNow();
      startPump();
    } else {
      stopPump();
    }
  });

  // 此刻时钟仍处于冻结态,正好把欠下的回调补齐,再由 clock 重算 offset
  clock.beforeRelease(() => {
    stopPump();
    if (!P.isOn()) return;
    const remain = clock.realNow() - clock.now();
    if (remain > 0) pump(remain);
  });

  P.sched = { pump, startPump, stopPump, timers, schedule, clearTimer };

  // 页面在后台被打开:配置送达前后都可能处于 holding,直接起 pump
  if (clock.holding) {
    lastPumpReal = clock.realNow();
    startPump();
  }
})();
