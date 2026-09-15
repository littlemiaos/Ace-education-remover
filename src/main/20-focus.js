'use strict';

/*
 * 20-focus.js — 窗口焦点
 *
 * 三个信号:
 *   1. document.hasFocus() —— 直接恒为 true。
 *   2. window 的 blur / focus 事件 —— 不投递。
 *   3. document.activeElement —— Chrome 在窗口失焦时会把 activeElement 退回
 *      body;失焦期间回放「最后一次真正聚焦过的元素」,避免这个副产物露馅。
 *
 * 未覆盖:CSS 侧的 :focus / :focus-within、document.body.matches(':focus') 等
 * 由渲染引擎决定,JS 层改不了,harness 里单独列出。
 */

(() => {
  const P = globalThis.__PVG__;
  if (!P) return;
  if (P.appliedFocus) return; // 幂等,理由同 10-visibility.js
  P.appliedFocus = true;
  const { natives } = P;

  const isWin = (t) => t === globalThis;

  /* ------------------------------------------------------- hasFocus() */

  const hfDesc = P.findDesc(Document.prototype, 'hasFocus');
  if (hfDesc && hfDesc.value) {
    P.replaceMethod(
      Document.prototype,
      'hasFocus',
      function hasFocus() {
        return P.isOn() ? true : natives.apply(hfDesc.value, this, []);
      },
      'hasFocus',
      0
    );
  }

  /* ---------------------------------------------------- activeElement */

  const aeDesc = P.findDesc(Document.prototype, 'activeElement');
  if (aeDesc && aeDesc.get && natives.docActiveElement) {
    const lastActive = new WeakMap();

    natives.addEventListener.call(
      document,
      'focusin',
      () => {
        const el = natives.apply(natives.docActiveElement, document, []);
        if (el && el !== document.body) lastActive.set(document, el);
      },
      true
    );

    P.replaceGetter(
      Document.prototype,
      'activeElement',
      function activeElement() {
        const el = natives.apply(aeDesc.get, this, []);
        if (!P.isOn() || P.real.focused) return el;
        const memo = lastActive.get(this);
        return memo && memo !== el && memo.isConnected ? memo : el;
      },
      'activeElement'
    );
  }

  /* -------------------------------------------------- blur / focus 事件 */

  P.mask.installEventFilter();
  P.mask.addPolicy((target, type) => {
    if (type !== 'blur' && type !== 'focus') return null;
    return isWin(target) ? { mode: 'drop' } : null;
  });
  P.mask.maskHandler(Window.prototype, 'onblur');
  P.mask.maskHandler(Window.prototype, 'onfocus');
})();
