'use strict';

/*
 * PVG · ISOLATED world 桥
 *
 * MAIN world 拿不到 chrome.* API,所以配置通过 postMessage + CustomEvent 两条路
 * 送进去(CustomEvent.detail 的跨世界可见性在各版本上不一致,postMessage 更稳)。
 *
 * 注意:这两种通道页面自己也能监听/伪造。对「自检自己站点」的场景这没有问题 ——
 * 最坏情况是页面把配置改成 enabled:false,即让自己失去遮蔽,不构成提权。
 * 若要让通道不可伪造,需要改成把配置烧进注册时选定的文件集合(特性开关已经这么做了)。
 */

(() => {
  const CHANNEL = 1;
  const EVENT = '__pvg_config__';

  let lastJson = '';

  function deliver(raw) {
    if (!raw || typeof raw !== 'object') return;
    const cfg = {
      enabled: raw.enabled !== false,
      options: raw.options && typeof raw.options === 'object' ? raw.options : {},
      features: raw.features && typeof raw.features === 'object' ? raw.features : {}
    };
    const json = JSON.stringify(cfg);
    if (json === lastJson) return;
    lastJson = json;

    try {
      window.postMessage({ __pvg: CHANNEL, cfg }, '*');
    } catch (_) {}
    try {
      document.dispatchEvent(new CustomEvent(EVENT, { detail: { __pvg: CHANNEL, cfg } }));
    } catch (_) {}
  }

  async function load() {
    try {
      const bag = await chrome.storage.local.get('pvgConfig');
      const cfg = bag && bag.pvgConfig;
      if (cfg) deliver(cfg);
    } catch (_) {}
  }

  load();
  document.addEventListener('DOMContentLoaded', load, { once: true });

  // options / popup 的实时改动能立刻生效,不必刷新页面
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'pvg:config' && msg.config) {
        deliver(msg.config);
        sendResponse({ ok: true });
      } else if (msg.type === 'pvg:liveState') {
        sendResponse({ ok: true, enabled: lastJson ? JSON.parse(lastJson).enabled !== false : true });
      }
    });
  } catch (_) {}
})();
