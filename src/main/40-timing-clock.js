'use strict';

/*
 * 40-timing-clock.js — 时序遮蔽第一层:虚拟时钟
 *
 * 核心模型:
 *
 *     virtual = min( realNow() - offset , ceiling )
 *
 *   - 前台:ceiling = Infinity,offset 不变 => 虚拟时钟与真实时间 1:1 前进。
 *     所以 Date.now() / performance.now() 与墙钟不产生可观测漂移 —— 这一点很关键,
 *     否则「客户端时间落后服务器时间」是最好用的一把刀。
 *   - 真实进入后台:hold() 把 ceiling 钉死在当时的虚拟时刻。页面看到时钟被冻结,
 *     且表达式里用的是 min,时钟永远单调、不会回退(回退是最容易被抓的破绽)。
 *   - 冻结期间由 41 的 pump 把 ceiling 按「被补投递的回调到期时刻」逐步推进:
 *     页面因此观测到 interval 回调按 1s 间距到达、时间戳间距也正常。
 *   - 恢复前台:release() 先跑 beforeRelease 钩子(此时时钟仍处于冻结态,调度器可以
 *     把欠下的回调补齐),再用 offset = realNow - ceiling 把时钟无缝接上。
 *
 * 没被补投递掉的后台时长会沉淀进 offset,也就是虚拟时钟相对墙钟的漂移。
 * 正常情况下每个 pump 都能覆盖满一个真实周期,漂移≈0;只有当我们截断补投递预算
 * (intensive throttling 下后台长达 1 分钟才醒一次)时漂移才会累积。harness 会量它。
 */

(() => {
  const P = globalThis.__PVG__;
  if (!P) return;
  if (P.clock) return;
  const { natives, disguise } = P;

  const realNow = () => natives.apply(natives.perfNow, performance, []);
  const timeOrigin = performance.timeOrigin;

  let offset = 0;
  let ceiling = Infinity;
  const beforeRelease = [];

  const now = () => {
    if (!P.isOn()) return realNow();
    const v = realNow() - offset;
    return v < ceiling ? v : ceiling;
  };

  const clock = {
    now,
    realNow,
    get offset() {
      return offset;
    },
    get holding() {
      return ceiling !== Infinity;
    },
    /** 墙钟纪元下的虚拟时间,让 Date 与 performance 保持同一时间轴 */
    epoch: () => timeOrigin + now(),
    hold() {
      if (ceiling === Infinity) ceiling = now();
    },
    /** 把冻结中的虚拟时钟向前推 ms(单调) */
    advance(ms) {
      if (ceiling !== Infinity && ms > 0) ceiling += ms;
    },
    beforeRelease: (fn) => beforeRelease.push(fn),
    release() {
      if (ceiling === Infinity) return;
      for (const fn of beforeRelease) {
        try {
          fn();
        } catch (e) {
          P.log(e);
        }
      }
      offset = realNow() - ceiling;
      if (offset < 0) offset = 0;
      ceiling = Infinity;
    }
  };
  P.clock = clock;

  /* ------------------------------------------------- performance.now() */

  const pnDesc = P.findDesc(Performance.prototype, 'now');
  if (pnDesc && pnDesc.value) {
    P.replaceMethod(
      Performance.prototype,
      'now',
      function now() {
        return P.isOn() ? clock.now() : natives.apply(pnDesc.value, this, []);
      },
      'now',
      0
    );
  }

  /* ---------------------------------------------------- Date 构造与静态 */

  const RealDate = natives.DateCtor;
  const dateProto = natives.dateProto;

  const PatchedDate = disguise(
    function Date(...args) {
      if (!new.target) return new RealDate(clock.epoch()).toString();
      if (args.length === 0) return new RealDate(clock.epoch());
      return new RealDate(...args);
    },
    'Date',
    { length: 7 }
  );

  natives.defineProperty(PatchedDate, 'prototype', {
    value: dateProto,
    writable: false,
    enumerable: false,
    configurable: false
  });
  natives.defineProperty(PatchedDate, 'now', {
    value: disguise(function now() {
      return clock.epoch();
    }, 'now', { length: 0 }),
    writable: true,
    enumerable: false,
    configurable: true
  });
  natives.defineProperty(PatchedDate, 'parse', {
    value: disguise(function parse(s) {
      return RealDate.parse(s);
    }, 'parse', { length: 1 }),
    writable: true,
    enumerable: false,
    configurable: true
  });
  natives.defineProperty(PatchedDate, 'UTC', {
    value: disguise(function UTC(...a) {
      return RealDate.UTC(...a);
    }, 'UTC', { length: 7 }),
    writable: true,
    enumerable: false,
    configurable: true
  });

  // (new Date()).constructor === Date 必须成立
  natives.defineProperty(dateProto, 'constructor', {
    value: PatchedDate,
    writable: true,
    enumerable: false,
    configurable: true
  });
  natives.defineProperty(globalThis, 'Date', {
    value: PatchedDate,
    writable: true,
    enumerable: false,
    configurable: true
  });

  // 普通函数的 [[Prototype]] 是 Function.prototype,而 Date 是内建构造器,
  // Object.getPrototypeOf(Date) 也应返回 Function.prototype —— 这里补齐避免露馅
  const gpo = Object.getPrototypeOf;
  const rgpo = Reflect.getPrototypeOf;
  P.replaceMethod(
    Object,
    'getPrototypeOf',
    function getPrototypeOf(o) {
      return o === PatchedDate ? Function.prototype : gpo(o);
    },
    'getPrototypeOf',
    1
  );
  P.replaceMethod(
    Reflect,
    'getPrototypeOf',
    function getPrototypeOf(o) {
      return o === PatchedDate ? Function.prototype : rgpo(o);
    },
    'getPrototypeOf',
    1
  );

  /* ------------------------------------------- 其它同时间轴的读数 */

  const tsDesc = P.findDesc(Event.prototype, 'timeStamp');
  if (tsDesc && tsDesc.get) {
    P.replaceGetter(
      Event.prototype,
      'timeStamp',
      function timeStamp() {
        const v = natives.apply(tsDesc.get, this, []);
        if (!P.isOn() || offset === 0) return v;
        const shifted = v - offset;
        return shifted > 0 ? shifted : 0;
      },
      'timeStamp'
    );
  }

  const stDesc = P.findDesc(PerformanceEntry.prototype, 'startTime');
  if (stDesc && stDesc.get) {
    P.replaceGetter(
      PerformanceEntry.prototype,
      'startTime',
      function startTime() {
        const v = natives.apply(stDesc.get, this, []);
        if (!P.isOn() || offset === 0) return v;
        const shifted = v - offset;
        return shifted > 0 ? shifted : 0;
      },
      'startTime'
    );
  }

  /* ------------------------------------------------------- 可见性接线 */

  P.onHiddenChange((hidden) => {
    if (!P.isOn()) return;
    if (hidden) clock.hold();
    else clock.release();
  });
  P.onConfigChange((on) => {
    if (!on) clock.release();
  });

  if (P.real.hidden) clock.hold();
})();
