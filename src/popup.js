'use strict';

/*
 * popup.js — 手动武装的主界面
 *
 * 这个文件就是「开始注入」按钮的全部逻辑。要点:
 *   · chrome.permissions.request 必须在用户手势里同步发起,所以点击回调里
 *     不能有任何 await 出现在它之前。
 *   · 武装之后只有两条路能让遮蔽真正生效:刷新页面(拿到 document_start 时序,
 *     可靠)或「仅注入当前页」(立即,但时序不可靠)。两者都如实写在界面上。
 *   · 停止注入时连同该源的权限一起收回,不留常驻授权。
 */

(() => {
  const { toMatchPatterns } = globalThis.PVGPatterns;
  const $ = (id) => document.getElementById(id);

  let config = null;
  let armed = [];
  let granted = [];
  let tab = null;
  let tabId = null;

  const send = (type, extra) => chrome.runtime.sendMessage(Object.assign({ type }, extra || {}));

  function hint(text, kind) {
    const el = $('armHint');
    el.className = 'hint' + (kind ? ' ' + kind : '');
    el.textContent = text;
  }

  const requestOrigins = (origins) =>
    new Promise((resolve) => {
      chrome.permissions.request({ origins }, (ok) => {
        void chrome.runtime.lastError;
        resolve(!!ok);
      });
    });

  const isInjectable = (url) => /^https?:\/\//i.test(String(url || ''));

  async function refresh() {
    const st = await send('pvg:getState', { tabId });
    if (!st || !st.ok) return;
    config = st.config;
    armed = st.armed || [];
    granted = st.granted || [];
    render();
  }

  function render() {
    $('master').className = 'pill ' + (config.enabled ? 'ok' : 'warn');
    $('master').textContent = config.enabled ? '已启用' : '总开关关闭';
    $('timingPill').textContent = 'timing: ' + config.features.timing;

    const list = $('armedList');
    list.textContent = '';
    $('armedEmpty').classList.toggle('hidden', armed.length > 0);

    for (const entry of armed) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'mono grow';
      name.textContent = entry.pattern;
      name.style.wordBreak = 'break-all';

      const covered = granted.includes(entry.pattern);
      const pill = document.createElement('span');
      pill.className = 'pill ' + (covered ? 'ok' : 'warn');
      pill.textContent = covered ? '已授权' : '缺权限';

      const del = document.createElement('button');
      del.className = 'danger';
      del.style.fontSize = '12px';
      del.style.padding = '3px 9px';
      del.textContent = '停止';
      del.addEventListener('click', async () => {
        const res = await send('pvg:disarm', { pattern: entry.pattern });
        if (res && res.ok) {
          armed = res.armed || [];
          granted = (await chrome.permissions.getAll()).origins || [];
          render();
          hint('已停止并收回 ' + entry.pattern, 'ok');
        }
      });

      li.append(name, pill, del);
      list.append(li);
    }

    $('stopAll').disabled = armed.length === 0;

    const extras = granted.filter((g) => !armed.some((a) => a.pattern === g));
    const btn = $('revokeExtras');
    btn.classList.toggle('hidden', extras.length === 0);
    btn.textContent = `收回未使用的授权(${extras.length})`;

    $('injectNow').disabled = !isInjectable(tab && tab.url);
  }

  /* --------------------------------------------------------------- 接线 */

  document.addEventListener('DOMContentLoaded', async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];
    tabId = tab && typeof tab.id === 'number' ? tab.id : null;

    if (isInjectable(tab && tab.url)) {
      try {
        $('target').value = new URL(tab.url).host;
      } catch (_) {}
    }

    await refresh();

    // 「开始注入」:先取权限,再注册,再刷新 —— 全部由一个实体点击触发
    $('arm').addEventListener('click', async () => {
      const input = $('target').value.trim();
      const patterns = toMatchPatterns(input);
      if (patterns.length === 0) {
        hint('网址无法识别。填域名(example.com)或完整网址都可以。', 'bad');
        return;
      }
      if (patterns[0].startsWith('file:')) {
        hint(
          'file:// 需要在扩展详情里单独开启「允许访问文件网址」。更推荐用本地 HTTP 服务:pwsh -File harness\\serve.ps1',
          'warn'
        );
        return;
      }

      // 注意:这一句必须紧跟在点击手势里,之前不能有 await
      $('arm').disabled = true;
      const ok = await requestOrigins(patterns);
      $('arm').disabled = false;

      if (!ok) {
        hint('未授予 ' + patterns.join(' , ') + ' 的权限,没有注入任何东西。', 'bad');
        return;
      }

      const res = await send('pvg:arm', { input, patterns, tabId });
      if (!res || !res.ok) {
        hint((res && res.error) || '注入失败', 'bad');
        return;
      }
      armed = res.armed || [];
      granted = (await chrome.permissions.getAll()).origins || [];
      render();
      hint(
        res.reloaded
          ? `已注入 ${patterns.join(' , ')},并刷新了 ${res.reloaded} 个标签页使其在 document_start 生效。`
          : `已注入 ${patterns.join(' , ')}。刷新页面后才会在 document_start 生效。`,
        'ok'
      );
    });

    // 次按钮:立即注入,明确标注时序不可靠
    $('injectNow').addEventListener('click', async () => {
      if (!isInjectable(tab && tab.url)) {
        hint('当前页面不支持注入(只有 http/https 可以)。', 'bad');
        return;
      }
      let host;
      try {
        host = new URL(tab.url).host;
      } catch (_) {
        hint('拿不到当前网址。', 'bad');
        return;
      }
      const patterns = toMatchPatterns(host);
      $('injectNow').disabled = true;
      const ok = await requestOrigins(patterns);
      $('injectNow').disabled = false;
      if (!ok) {
        hint('未授予 ' + patterns.join(' , ') + ' 的权限。', 'bad');
        return;
      }
      const res = await send('pvg:injectNow', { tabId });
      if (!res || !res.ok) {
        hint((res && res.error) || '注入失败', 'bad');
        return;
      }
      await refresh();
      hint('已立即注入当前页。它只覆盖「还没被读过的」取值 —— 时序不可靠,要可靠就刷新。', 'warn');
    });

    $('stopAll').addEventListener('click', async () => {
      const res = await send('pvg:disarmAll');
      if (res && res.ok) {
        armed = [];
        granted = (await chrome.permissions.getAll()).origins || [];
        render();
        hint('已全部停止,相关源权限一并收回。', 'ok');
      }
    });

    $('revokeExtras').addEventListener('click', async () => {
      const res = await send('pvg:revokeExtras');
      if (res && res.ok) {
        granted = (await chrome.permissions.getAll()).origins || [];
        render();
        hint(
          res.removed && res.removed.length ? '已收回:' + res.removed.join(' , ') : '没有需要收回的授权。',
          'ok'
        );
      }
    });

    $('openOptions').addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
      window.close();
    });
  });
})();
