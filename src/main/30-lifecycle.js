'use strict';

/*
 * 30-lifecycle.js — 生命周期(默认关闭)
 *
 * 为什么默认关:这一层直接作用于「真实的离开/卸载/关闭」链路。
 *   - beforeunload 被吞掉 => 页面自己的「确认离开」提示不再出现;
 *   - pagehide / unload 被吞掉 => 依赖它们上报的埋点、埋点式登出、状态保存不会跑。
 * 对自检而言这是「改变被测对象行为」,会影响你对站点真实行为的判断,所以必须显式开。
 *
 * 打开后的语义:
 *   freeze / resume      -> 不投递(freeze 本身就是「你被挂起了」的铁证)
 *   pagehide / unload    -> 不投递
 *   beforeunload         -> 不投递
 *   pageshow             -> 放行初始加载(persisted=false),只吞 bfcache 恢复
 *                           (persisted=true 等价于「你离开过又回来了」)
 */

(() => {
  const P = globalThis.__PVG__;
  if (!P) return;
  if (P.appliedLifecycle) return; // 幂等,理由同 10-visibility.js
  P.appliedLifecycle = true;

  const isDoc = (t) => t instanceof Document;
  const isWin = (t) => t === globalThis;

  P.mask.installEventFilter();
  P.mask.addPolicy((target, type) => {
    switch (type) {
      case 'freeze':
      case 'resume':
        return isDoc(target) ? { mode: 'drop' } : null;
      case 'pagehide':
      case 'unload':
      case 'beforeunload':
        return isWin(target) ? { mode: 'drop' } : null;
      case 'pageshow':
        return isWin(target)
          ? { mode: 'filter', allow: (ev) => !(ev && ev.persisted === true) }
          : null;
      default:
        return null;
    }
  });

  for (const prop of ['onfreeze', 'onresume']) P.mask.maskHandler(Document.prototype, prop);
  for (const prop of ['onpagehide', 'onpageshow', 'onunload', 'onbeforeunload']) {
    P.mask.maskHandler(Window.prototype, prop);
  }
})();
