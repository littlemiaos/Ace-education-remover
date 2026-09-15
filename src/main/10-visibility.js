'use strict';

/*
 * 10-visibility.js — Page Visibility API
 *
 * 思路:既然对外恒为 visible,就不存在「可见性发生变化」这件事,因此
 * visibilitychange / webkitvisibilitychange 一律不投递给页面。
 * 反过来说:永远不会有 visible 的转换事件需要补发,状态与事件天然自洽。
 */

(() => {
  const P = globalThis.__PVG__;
  if (!P) return;
  // 幂等:同一个页面可能被「注册注入」和「点按立即注入」两条路各打一次补丁,
  // 二次包装会让取值器层层套娃,必须挡住。
  if (P.appliedVisibility) return;
  P.appliedVisibility = true;
  const { natives } = P;

  const isDoc = (t) => t instanceof Document;
  const isWin = (t) => t === globalThis;

  /** 把 proto 上的取值器换成常量,但在总开关关闭时透传真实值 */
  function spoof(proto, prop, value) {
    const desc = P.findDesc(proto, prop);
    if (!desc || !desc.get || desc.configurable === false) return false;
    return P.replaceGetter(
      proto,
      prop,
      function () {
        return P.isOn() ? value : natives.apply(desc.get, this, []);
      },
      prop
    );
  }

  spoof(Document.prototype, 'hidden', false);
  spoof(Document.prototype, 'visibilityState', 'visible');
  // 历史上 Chrome 用 webkit 前缀暴露同一份状态,老检测代码仍在读
  spoof(Document.prototype, 'webkitHidden', false);
  spoof(Document.prototype, 'webkitVisibilityState', 'visible');
  // 被浏览器丢弃/回收过 = 说明长期不在前台
  spoof(Document.prototype, 'wasDiscarded', false);

  P.mask.installEventFilter();
  P.mask.addPolicy((target, type) => {
    if (type !== 'visibilitychange' && type !== 'webkitvisibilitychange') return null;
    return isDoc(target) || isWin(target) ? { mode: 'drop' } : null;
  });
  P.mask.maskHandler(Document.prototype, 'onvisibilitychange');
  P.mask.maskHandler(Document.prototype, 'onwebkitvisibilitychange');
})();
