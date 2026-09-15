'use strict';

/*
 * 42-timing-raf.js — 时序遮蔽第三层:requestAnimationFrame
 *
 * 后台标签页不渲染,原生 rAF 直接停摆 —— 这是最直白的检测点:只要数一秒内有几帧,
 * 0 帧就等于「不在前台」,而且它跟 setInterval 的限流是两个独立信号,容易被交叉验证。
 *
 * 做法:rAF 全部收进自己的队列。
 *   - 前台:转交原生 rAF,保留真实的「回调在绘制前执行」语义;
 *     时间戳减去 clock.offset,保证与打过补丁的 performance.now() 同一时间轴。
 *   - 后台:不挂原生(挂了也不会触发),由 41 的 pump 每个虚拟时间片喂一帧,
 *     所以页面看到的是稳定的 60fps 与 16.67ms 递增的时间戳。
 *   - 恢复前台:若补投递被预算截断,残余回调改回原生 rAF,避免动画永久停摆。
 */

(() => {
  const P = globalThis.__PVG__;
  if (!P) return;
  if (P.raf || !P.clock) return;
  const { natives } = P;
  const clock = P.clock;

  const pending = new Map(); // ourId -> cb
  const armed = new Map(); // ourId -> 原生 handle
  let seq = 1;

  function arm(id) {
    const cb = pending.get(id);
    if (!cb) return;
    const handle = natives.apply(natives.rAF, globalThis, [
      function (t) {
        armed.delete(id);
        if (!pending.has(id)) return;
        // 关键:此刻若已进入冻结态(例如 hold 与这一次原生帧几乎同时发生),
        // 必须把回调留在 pending 里交给 pump,而不是删掉它 —— 删了就等于吞掉一帧,
        // 动画会永久停摆。
        if (clock.holding) return;
        pending.delete(id);
        try {
          cb.call(globalThis, P.isOn() ? Math.max(0, t - clock.offset) : t);
        } catch (e) {
          P.rethrow(e);
        }
      }
    ]);
    armed.set(id, handle);
  }

  P.replaceMethod(
    globalThis,
    'requestAnimationFrame',
    function requestAnimationFrame(cb) {
      if (!P.isOn() || typeof cb !== 'function') {
        return natives.apply(natives.rAF, globalThis, arguments);
      }
      const id = seq++;
      pending.set(id, cb);
      if (!clock.holding) arm(id);
      return id;
    },
    'requestAnimationFrame',
    1
  );

  P.replaceMethod(
    globalThis,
    'cancelAnimationFrame',
    function cancelAnimationFrame(id) {
      if (pending.has(id)) {
        pending.delete(id);
        const handle = armed.get(id);
        if (handle !== undefined) {
          armed.delete(id);
          natives.apply(natives.cAF, globalThis, [handle]);
        }
        return undefined;
      }
      return natives.apply(natives.cAF, globalThis, arguments);
    },
    'cancelAnimationFrame',
    1
  );

  // pump 的每个虚拟时间片调用一次
  P.frameSources.push((t) => {
    if (pending.size === 0) return;
    const batch = Array.from(pending.entries());
    pending.clear();
    for (let i = 0; i < batch.length; i++) {
      try {
        batch[i][1].call(globalThis, t);
      } catch (e) {
        P.rethrow(e);
      }
    }
  });

  clock.beforeRelease(() => {
    for (const id of Array.from(pending.keys())) arm(id);
  });

  P.raf = { pending, armed };
})();
