'use strict';

/*
 * options.js — 设置页
 *
 * 只负责三件事:特性/时序开关、注入目标的只读视图 + 停止、诊断信息。
 * 注入本身不在这里发起 —— 那是弹窗里那个必须手动点的按钮的职责。
 */

(() => {
  const $ = (id) => document.getElementById(id);

  let config = null;
  let armed = [];
  let granted = [];
  let status = null;

  const TIMING_DESC = {
    off: '不打任何时序补丁。用于采集基线:后台标签页会被限流、rAF 停摆,一眼可辨。',
    freeze: '只冻结虚拟时钟。interval 回调仍会一次性迟到,但回调内读到的时间差接近 0。注意:后台时长会 100% 变成时钟漂移,Worker/服务器时间一对比就露。',
    replay: '冻结时钟 + 按原定到期时刻补投递回调 + 补帧。回调密度、时间戳间距都像前台,漂移≈0。代价是补投递成批发生,CPU 有尖峰。'
  };

  const send = (type, extra) => chrome.runtime.sendMessage(Object.assign({ type }, extra || {}));

  async function refresh() {
    const res = await send('pvg:getState');
    if (!res || !res.ok) return;
    config = res.config;
    armed = res.armed || [];
    granted = res.granted || [];
    status = res.status;
    render();
  }

  function render() {
    $('enabled').checked = !!config.enabled;
    $('fVisibility').checked = !!config.features.visibility;
    $('fFocus').checked = !!config.features.focus;
    $('fLifecycle').checked = !!config.features.lifecycle;
    $('timing').value = config.features.timing;
    $('timingDesc').textContent = TIMING_DESC[config.features.timing] || '';

    $('optMaxVirtual').value = config.options.maxVirtualMsPerPump;
    $('optMaxCallbacks').value = config.options.maxCallbacksPerPump;
    $('optMinReplay').value = config.options.minReplayIntervalMs;

    /* --- 注入目标(只读) --- */
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
      del.textContent = '停止';
      del.addEventListener('click', async () => {
        await send('pvg:disarm', { pattern: entry.pattern });
        await refresh();
      });

      li.append(name, pill, del);
      list.append(li);
    }

    $('stopAll').disabled = armed.length === 0;
    const extras = granted.filter((g) => !armed.some((a) => a.pattern === g));
    const revoke = $('revokeExtras');
    revoke.classList.toggle('hidden', extras.length === 0);
    revoke.textContent = `收回未使用的授权(${extras.length})`;

    /* --- 注册状态 --- */
    const pill = $('regStatus');
    if (!config.enabled) {
      pill.className = 'pill warn';
      pill.textContent = '总开关已关';
    } else if (!status) {
      pill.className = 'pill';
      pill.textContent = '未同步';
    } else if (!status.ok) {
      pill.className = 'pill bad';
      pill.textContent = '注册失败';
    } else if (!status.matches || status.matches.length === 0) {
      pill.className = 'pill warn';
      pill.textContent = '未注入任何目标';
    } else {
      pill.className = 'pill ok';
      pill.textContent = `生效 · ${status.matches.length} 个目标`;
    }
    $('regDetail').textContent = status
      ? status.error
        ? `错误:${status.error}`
        : status.note || `已注册:${(status.matches || []).join(' , ')}`
      : '';

    /* --- 诊断 --- */
    const rows = [
      ['版本', chrome.runtime.getManifest().version],
      ['总开关', config.enabled ? '开' : '关'],
      ['已注入目标', armed.length ? armed.map((a) => a.pattern).join(' , ') : '(无)'],
      ['已授予的源', granted.length ? granted.join(' , ') : '(无)'],
      ['动态注册的文件', (status && status.files && status.files.join(' → ')) || '(无)'],
      ['注册持久性', 'persistAcrossSessions: false(仅本次会话)'],
      ['最近同步', status && status.at ? new Date(status.at).toLocaleString() : '—']
    ];
    const tbody = $('diag');
    tbody.textContent = '';
    for (const [k, v] of rows) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = k;
      const td = document.createElement('td');
      td.className = 'mono';
      td.textContent = v;
      tr.append(th, td);
      tbody.append(tr);
    }
  }

  async function save() {
    const res = await send('pvg:setConfig', { config });
    if (res && res.ok) config = res.config;
    await refresh();
  }

  /* --------------------------------------------------------------- 接线 */

  document.addEventListener('DOMContentLoaded', () => {
    $('enabled').addEventListener('change', (e) => {
      config.enabled = e.target.checked;
      save();
    });
    for (const [id, key] of [
      ['fVisibility', 'visibility'],
      ['fFocus', 'focus'],
      ['fLifecycle', 'lifecycle']
    ]) {
      $(id).addEventListener('change', (e) => {
        config.features[key] = e.target.checked;
        save();
      });
    }
    $('timing').addEventListener('change', (e) => {
      config.features.timing = e.target.value;
      save();
    });
    for (const [id, key, min] of [
      ['optMaxVirtual', 'maxVirtualMsPerPump', 1000],
      ['optMaxCallbacks', 'maxCallbacksPerPump', 100],
      ['optMinReplay', 'minReplayIntervalMs', 4]
    ]) {
      $(id).addEventListener('change', (e) => {
        const v = Math.max(min, Number(e.target.value) || min);
        config.options[key] = v;
        e.target.value = v;
        save();
      });
    }

    $('stopAll').addEventListener('click', async () => {
      await send('pvg:disarmAll');
      await refresh();
    });
    $('revokeExtras').addEventListener('click', async () => {
      await send('pvg:revokeExtras');
      await refresh();
    });
    $('resync').addEventListener('click', async () => {
      await send('pvg:sync');
      await refresh();
    });

    const cmd = 'pwsh -File "harness\\serve.ps1"   # 然后打开 http://127.0.0.1:8765/';
    $('harnessCmd').textContent = cmd;
    $('copyHarnessPath').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(cmd);
        $('harnessCmd').textContent = '已复制:' + cmd;
      } catch (_) {
        $('harnessCmd').textContent = cmd;
      }
    });
    $('openHarness').addEventListener('click', () => {
      chrome.tabs.create({ url: 'http://127.0.0.1:8765/' });
    });

    refresh();
  });
})();
