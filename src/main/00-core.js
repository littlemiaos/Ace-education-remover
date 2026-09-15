'use strict';

/*
 * 00-core.js — PVG MAIN world 核心层(必须最先执行)
 *
 * 提供四件事:
 *   1. natives 快照:在任何补丁之前抓住原生实现,后续补丁一律走快照,避免自我污染。
 *   2. ground truth:用原生监听器持续跟踪「真实」可见性/焦点/冻结状态。补丁只影响
 *      页面看到的视图,我们自己始终知道真相 —— 这是遮蔽逻辑能自洽的前提。
 *   3. 伪装层:让被替换的函数/访问器在 Function.prototype.toString、name、length、
 *      描述符标志位上都与原生一致。
 *   4. 事件屏蔽框架:addEventListener / on* 属性统一走策略表,支持整体开关。
 */

(() => {
  const W = globalThis;
  if (W.__PVG__ && W.__PVG__.installed) return;

  /* ------------------------------------------------------------ natives */

  const gOPD = Object.getOwnPropertyDescriptor;
  const defineProperty = Object.defineProperty;
  const apply = Reflect.apply;

  function findDesc(obj, prop) {
    let o = obj;
    while (o) {
      const d = gOPD(o, prop);
      if (d) return d;
      o = Object.getPrototypeOf(o);
    }
    return null;
  }

  const docHasFocusDesc = findDesc(Document.prototype, 'hasFocus');
  const docActiveElDesc = findDesc(Document.prototype, 'activeElement');
  const docHiddenDesc = findDesc(Document.prototype, 'hidden');
  const docVisibilityDesc = findDesc(Document.prototype, 'visibilityState');

  const natives = {
    gOPD,
    defineProperty,
    apply,
    findDesc,
    getPrototypeOf: Object.getPrototypeOf,
    ownKeys: Reflect.ownKeys,
    addEventListener: EventTarget.prototype.addEventListener,
    removeEventListener: EventTarget.prototype.removeEventListener,
    fnToString: Function.prototype.toString,
    dateNow: Date.now,
    DateCtor: Date,
    dateProto: Date.prototype,
    perfNow: Performance.prototype.now,
    perfTimeOrigin: performance.timeOrigin,
    docHasFocus: docHasFocusDesc && docHasFocusDesc.value,
    docActiveElement: docActiveElDesc && docActiveElDesc.get,
    docHidden: docHiddenDesc && docHiddenDesc.get,
    docVisibility: docVisibilityDesc && docVisibilityDesc.get,
    setTimeout: W.setTimeout,
    clearTimeout: W.clearTimeout,
    setInterval: W.setInterval,
    clearInterval: W.clearInterval,
    rAF: W.requestAnimationFrame,
    cAF: W.cancelAnimationFrame
  };

  /* --------------------------------------------------------------- 配置 */

  const config = {
    enabled: true,
    debug: false,
    options: {
      maxVirtualMsPerPump: 65000,
      maxCallbacksPerPump: 4000,
      minReplayIntervalMs: 20,
      frameIntervalMs: 1000 / 60,
      debug: false
    }
  };

  const log = (...a) => {
    if (config.debug) {
      try {
        console.debug('[PVG]', ...a);
      } catch (_) {}
    }
  };

  const isOn = () => config.enabled !== false;

  const rethrow = (e) => {
    // 原生定时器回调抛错会变成未捕获异常;这里复刻该行为而不是吞掉
    try {
      natives.setTimeout.call(W, () => {
        throw e;
      }, 0);
    } catch (_) {}
  };

  const configWatchers = [];
  const onConfigChange = (fn) => configWatchers.push(fn);
  const handlerRestorers = [];

  function setConfig(incoming) {
    if (!incoming || typeof incoming !== 'object') return;
    const wasOn = isOn();
    if (typeof incoming.enabled === 'boolean') config.enabled = incoming.enabled;
    if (incoming.options && typeof incoming.options === 'object') {
      for (const k of Object.keys(config.options)) {
        const v = incoming.options[k];
        if (k === 'debug' ? typeof v === 'boolean' : typeof v === 'number' && isFinite(v)) {
          config.options[k] = v;
        }
      }
    }
    if (config.options.debug !== undefined) config.debug = !!config.options.debug;
    if (wasOn !== isOn()) {
      if (!isOn()) {
        // 关掉遮蔽时把屏蔽过的 on* 处理器交还原生槽位,页面行为立刻恢复
        for (const fn of handlerRestorers) {
          try {
            fn();
          } catch (e) {
            log(e);
          }
        }
      }
      for (const fn of configWatchers) {
        try {
          fn(isOn());
        } catch (e) {
          log(e);
        }
      }
    }
  }

  /* -------------------------------------------------------- ground truth */

  const real = { hidden: false, visibilityState: 'visible', focused: true, frozen: false };

  const readHidden = () => (natives.docHidden ? !!apply(natives.docHidden, document, []) : false);
  const readVisibility = () =>
    natives.docVisibility ? String(apply(natives.docVisibility, document, [])) : 'visible';
  const readFocus = () => (natives.docHasFocus ? !!apply(natives.docHasFocus, document, []) : true);
  const readActive = () => (natives.docActiveElement ? apply(natives.docActiveElement, document, []) : null);

  const hiddenWatchers = [];
  const onHiddenChange = (fn) => hiddenWatchers.push(fn);
  let lastHidden = null;

  function syncReal() {
    real.hidden = readHidden();
    real.visibilityState = readVisibility();
    real.focused = readFocus();
    if (lastHidden === null) {
      lastHidden = real.hidden;
      return;
    }
    if (lastHidden !== real.hidden) {
      lastHidden = real.hidden;
      for (const fn of hiddenWatchers) {
        try {
          fn(real.hidden);
        } catch (e) {
          log(e);
        }
      }
    }
  }

  // 这些监听器必须在替换 addEventListener 之前用原生注册,才能始终拿到真相
  natives.addEventListener.call(document, 'visibilitychange', syncReal, true);
  natives.addEventListener.call(document, 'freeze', () => { real.frozen = true; }, true);
  natives.addEventListener.call(document, 'resume', () => { real.frozen = false; }, true);
  natives.addEventListener.call(W, 'focus', syncReal, true);
  natives.addEventListener.call(W, 'blur', syncReal, true);
  syncReal();

  /* ------------------------------------------------------------- 伪装层 */

  const disguised = new WeakMap();
  const srcFunction = (name) => `function ${name}() { [native code] }`;
  const srcGetter = (name) => `function get ${name}() { [native code] }`;
  const srcSetter = (name) => `function set ${name}() { [native code] }`;

  /**
   * 让 fn 在 toString/name/length 上看起来像原生。
   * meta.accessor: 'get' | 'set';meta.length: 期望的 length。
   */
  function disguise(fn, name, meta) {
    const acc = meta && meta.accessor;
    try {
      defineProperty(fn, 'name', { value: name, configurable: true });
    } catch (_) {}
    if (meta && typeof meta.length === 'number') {
      try {
        defineProperty(fn, 'length', { value: meta.length, configurable: true });
      } catch (_) {}
    }
    disguised.set(fn, acc === 'get' ? srcGetter(name) : acc === 'set' ? srcSetter(name) : srcFunction(name));
    return fn;
  }

  const rawFnToString = natives.fnToString;
  const patchedFnToString = disguise(
    function toString() {
      const src = disguised.get(this);
      if (src !== undefined) return src;
      return apply(rawFnToString, this, []);
    },
    'toString',
    { length: 0 }
  );
  disguised.set(patchedFnToString, srcFunction('toString'));
  natives.defineProperty(Function.prototype, 'toString', {
    value: patchedFnToString,
    writable: true,
    enumerable: false,
    configurable: true
  });

  /** 按原描述符的标志位替换一个方法 */
  function replaceMethod(obj, prop, impl, name, length) {
    const desc = findDesc(obj, prop);
    if (!desc || desc.configurable === false) return false;
    natives.defineProperty(obj, prop, {
      value: disguise(impl, name || prop, { length: length === undefined ? desc.value && desc.value.length : length }),
      writable: desc.writable !== false,
      enumerable: !!desc.enumerable,
      configurable: true
    });
    return true;
  }

  /** 替换一个访问器,保持 enumerable */
  function replaceGetter(obj, prop, getter, name) {
    const desc = findDesc(obj, prop);
    if (!desc || desc.configurable === false) return false;
    natives.defineProperty(obj, prop, {
      get: disguise(getter, name || prop, { accessor: 'get', length: 0 }),
      set: desc.set,
      enumerable: !!desc.enumerable,
      configurable: true
    });
    return true;
  }

  /* -------------------------------------------------------- 事件屏蔽框架 */

  const policies = [];
  const addPolicy = (fn) => policies.push(fn);

  function decide(target, type) {
    if (!isOn()) return null;
    for (let i = 0; i < policies.length; i++) {
      let r;
      try {
        r = policies[i](target, type);
      } catch (e) {
        log(e);
      }
      if (r) return r;
    }
    return null;
  }

  const invokeListener = (listener, thisArg, event) => {
    if (typeof listener === 'function') return listener.call(thisArg, event);
    if (listener && typeof listener.handleEvent === 'function') return listener.handleEvent(event);
    return undefined;
  };

  let filterInstalled = false;

  /**
   * 关键取舍:即使策略是 drop,也照样注册一个 wrapper,由 wrapper 在派发时判断。
   * 这样运行时关掉遮蔽(总开关 / 本站停用)能立刻恢复页面原有行为,而不需要重新加载。
   */
  function installEventFilter() {
    if (filterInstalled) return;
    filterInstalled = true;

    const proto = EventTarget.prototype;
    const origAdd = natives.addEventListener;
    const origRemove = natives.removeEventListener;
    const registry = new WeakMap(); // target -> [{type, listener, capture, wrapper}]

    const captureOf = (options) =>
      typeof options === 'boolean' ? options : !!(options && options.capture);

    const remember = (target, entry) => {
      let list = registry.get(target);
      if (!list) {
        list = [];
        registry.set(target, list);
      }
      list.push(entry);
    };
    const find = (target, type, listener, capture) => {
      const list = registry.get(target);
      if (!list) return null;
      for (const e of list) {
        if (e.type === type && e.listener === listener && e.capture === capture) return e;
      }
      return null;
    };
    const forget = (target, entry) => {
      const list = registry.get(target);
      if (!list) return;
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
    };

    const patchedAdd = disguise(
      function addEventListener(type, listener, options) {
        if (listener == null) return apply(origAdd, this, arguments);
        const name = String(type);
        const rule = decide(this, name);
        if (!rule) return apply(origAdd, this, arguments);

        const entry = { type: name, listener, capture: captureOf(options), wrapper: null };
        entry.wrapper = disguise(
          function (event) {
            if (isOn()) {
              if (rule.mode === 'drop') return undefined;
              if (rule.mode === 'filter') {
                let allow = true;
                try {
                  allow = rule.allow(event) !== false;
                } catch (e) {
                  allow = true;
                }
                if (!allow) return undefined;
              }
            }
            return invokeListener(listener, this, event);
          },
          typeof listener === 'function' ? listener.name : '',
          { length: 1 }
        );
        remember(this, entry);
        return apply(origAdd, this, [type, entry.wrapper, options]);
      },
      'addEventListener',
      { length: 2 }
    );

    const patchedRemove = disguise(
      function removeEventListener(type, listener, options) {
        const name = String(type);
        const entry = find(this, name, listener, captureOf(options));
        if (entry) {
          forget(this, entry);
          return apply(origRemove, this, [type, entry.wrapper, options]);
        }
        return apply(origRemove, this, arguments);
      },
      'removeEventListener',
      { length: 2 }
    );

    replaceMethod(proto, 'addEventListener', patchedAdd, 'addEventListener', 2);
    replaceMethod(proto, 'removeEventListener', patchedRemove, 'removeEventListener', 2);
  }

  /**
   * 屏蔽 on<event> 属性处理器:值仍然可读回(保持行为一致),但永远不会被调用。
   * 关闭遮蔽时把值转发回原生 setter,恢复真实行为。
   */
  function maskHandler(proto, prop) {
    const desc = findDesc(proto, prop);
    if (!desc || desc.configurable === false) return false;
    const store = new WeakMap();
    const instances = new Set(); // 只有 document / window 级实例,强引用可接受

    const getter = disguise(
      function () {
        if (isOn() && store.has(this)) return store.get(this);
        if (desc.get) return apply(desc.get, this, []);
        return store.has(this) ? store.get(this) : null;
      },
      prop,
      { accessor: 'get' }
    );
    const setter = disguise(
      function (v) {
        instances.add(this);
        store.set(this, v);
        if (!desc.set) return;
        // 遮蔽中:原生槽位恒为 null,处理器永远不会被调用
        apply(desc.set, this, [isOn() ? null : v]);
      },
      prop,
      { accessor: 'set', length: 1 }
    );

    natives.defineProperty(proto, prop, {
      get: getter,
      set: setter,
      enumerable: !!desc.enumerable,
      configurable: true
    });

    handlerRestorers.push(() => {
      if (!desc.set) return;
      for (const inst of instances) {
        const v = store.has(inst) ? store.get(inst) : null;
        try {
          apply(desc.set, inst, [v === undefined ? null : v]);
        } catch (e) {
          log(e);
        }
      }
    });
    return true;
  }

  /* ------------------------------------------------------------- 对外 API */

  const PVG = {
    installed: true,
    version: '1.0.0',
    natives,
    real,
    syncReal,
    readHidden,
    readVisibility,
    readFocus,
    readActive,
    onHiddenChange,
    isOn,
    setConfig,
    onConfigChange,
    getOptions: () => config.options,
    getConfig: () => config,
    disguise,
    findDesc,
    replaceMethod,
    replaceGetter,
    rethrow,
    log,
    frameSources: [],
    mask: { addPolicy, installEventFilter, maskHandler, policies }
  };

  W.__PVG__ = PVG;

  // 配置通道:ISOLATED 桥会同时用 postMessage 和 CustomEvent 投递
  natives.addEventListener.call(
    W,
    'message',
    (e) => {
      if (e.source !== W || !e.data || e.data.__pvg !== 1) return;
      setConfig(e.data.cfg);
    },
    false
  );
  natives.addEventListener.call(
    document,
    '__pvg_config__',
    (e) => {
      const d = e.detail;
      if (d && d.__pvg === 1) setConfig(d.cfg);
    },
    false
  );
})();
