'use strict';

/*
 * PVG · service worker(ES module)
 *
 * 注入模型:**手动武装 + 仅本次会话**
 *
 *   1. 扩展启动时什么都不注入。没有任何常驻的"作用范围"。
 *   2. 只有用户在弹窗里输入目标网址并点下实体按钮,那个源才会被写进
 *      chrome.storage.session 的 armed 列表 —— session 存储随浏览器关闭清空。
 *   3. 注册的 content script 一律 persistAcrossSessions: false,同样随会话消失。
 *   4. 每次武装都要现取该源的权限;停止注入时把权限也收回。
 *
 * 换来的性质是「无常驻能力」:不存在一份写好的名单让扩展自动作用于某些站点,
 * 作用范围始终等于用户此时此刻手动点过的那些源,而且随时可以清空。
 *
 * 需要说清楚的一点:「必须点按钮」本身不是检测机制,它检测不到任何人的意图,
 * 也挡不住自动化点击。它只是把常驻能力换成当场授权,减少的是攻击面而不是别的。
 */

import './patterns.js'; // 副作用导入:挂载 globalThis.PVGPatterns

const { toMatchPatterns, parsePattern, isCovered, urlMatchesPattern } = globalThis.PVGPatterns;

const MAIN_ID = 'pvg-main';
const BRIDGE_ID = 'pvg-bridge';
const ALL_IDS = [MAIN_ID, BRIDGE_ID];
const CONFIG_KEY = 'pvgConfig';
const ARMED_KEY = 'pvgArmed';
const STATUS_KEY = 'pvgStatus';

const DEFAULT_CONFIG = {
  version: 2,
  enabled: true,
  features: {
    visibility: true,
    focus: true,
    lifecycle: false, // pagehide/pageshow/beforeunload/unload,默认关:会影响真实离站行为
    timing: 'replay' // 'off' | 'freeze' | 'replay'
  },
  options: {
    maxVirtualMsPerPump: 65000,
    maxCallbacksPerPump: 4000,
    minReplayIntervalMs: 20,
    frameIntervalMs: 1000 / 60,
    debug: false
  }
};

/* ------------------------------------------------------------------ config */

function normalizeConfig(raw) {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (!raw || typeof raw !== 'object') return cfg;
  if (typeof raw.enabled === 'boolean') cfg.enabled = raw.enabled;
  if (raw.features && typeof raw.features === 'object') {
    const f = raw.features;
    if (typeof f.visibility === 'boolean') cfg.features.visibility = f.visibility;
    if (typeof f.focus === 'boolean') cfg.features.focus = f.focus;
    if (typeof f.lifecycle === 'boolean') cfg.features.lifecycle = f.lifecycle;
    if (f.timing === 'off' || f.timing === 'freeze' || f.timing === 'replay') cfg.features.timing = f.timing;
  }
  if (raw.options && typeof raw.options === 'object') {
    for (const k of Object.keys(cfg.options)) {
      const v = raw.options[k];
      if (k === 'debug' ? typeof v === 'boolean' : typeof v === 'number' && isFinite(v)) cfg.options[k] = v;
    }
  }
  return cfg;
}

async function loadConfig() {
  const bag = await chrome.storage.local.get(CONFIG_KEY);
  const raw = bag[CONFIG_KEY];
  // v1 用的持久白名单(sites)已被手动武装取代。读一次,作为一次性提示,然后清掉。
  const legacySites = raw && Array.isArray(raw.sites) && raw.sites.length > 0 ? raw.sites.length : 0;
  return { cfg: normalizeConfig(raw), legacySites };
}

async function saveConfig(cfg) {
  const clean = normalizeConfig(cfg);
  await chrome.storage.local.set({ [CONFIG_KEY]: clean });
  return clean;
}

/* ------------------------------------------------------------------- armed */

async function loadArmed() {
  try {
    const bag = await chrome.storage.session.get(ARMED_KEY);
    const list = bag[ARMED_KEY];
    return Array.isArray(list) ? list.filter((e) => e && typeof e.pattern === 'string') : [];
  } catch (_) {
    return [];
  }
}

async function saveArmed(list) {
  const seen = new Set();
  const clean = [];
  for (const e of list) {
    if (!e || typeof e.pattern !== 'string' || seen.has(e.pattern)) continue;
    seen.add(e.pattern);
    clean.push({ pattern: e.pattern, host: String(e.host || ''), input: String(e.input || ''), at: Number(e.at) || 0 });
  }
  await chrome.storage.session.set({ [ARMED_KEY]: clean });
  return clean;
}

async function grantedOrigins() {
  try {
    return (await chrome.permissions.getAll()).origins || [];
  } catch (_) {
    return [];
  }
}

/* ------------------------------------------------------------- 注册文件清单 */

function mainWorldFiles(features) {
  const files = ['src/main/00-core.js'];
  if (features.visibility) files.push('src/main/10-visibility.js');
  if (features.focus) files.push('src/main/20-focus.js');
  if (features.lifecycle) files.push('src/main/30-lifecycle.js');
  if (features.timing === 'freeze') {
    files.push('src/main/40-timing-clock.js');
  } else if (features.timing === 'replay') {
    files.push('src/main/40-timing-clock.js', 'src/main/41-timing-sched.js', 'src/main/42-timing-raf.js');
  }
  return files;
}

/* ------------------------------------------------------------------- 同步 */

let queue = Promise.resolve();

function sync() {
  queue = queue.then(() => doSync()).catch(async (e) => {
    await chrome.storage.local.set({
      [STATUS_KEY]: { ok: false, error: String((e && e.message) || e), at: Date.now() }
    });
  });
  return queue;
}

async function doSync() {
  const { cfg, legacySites } = await loadConfig();
  const armed = await loadArmed();
  const granted = await grantedOrigins();

  const matches = cfg.enabled
    ? [...new Set(armed.map((a) => a.pattern).filter((p) => isCovered(p, granted)))]
    : [];
  const files = mainWorldFiles(cfg.features);
  const nothingToDo = matches.length === 0 || files.length <= 1;

  try {
    await chrome.scripting.unregisterContentScripts({ ids: ALL_IDS });
  } catch (_) {
    /* 本来就没注册 */
  }

  let note = '';
  if (legacySites) {
    note = `检测到 v1 的持久白名单(${legacySites} 条),已停用。现在的注入范围只由弹窗里的手动武装决定。`;
  } else if (uniqNote(armed, matches)) {
    note = '有已武装的目标缺少源权限,未能注册 —— 重新点一次「开始注入」以重新授权。';
  } else if (matches.length === 0) {
    note = '尚未武装任何目标。扩展不会自动作用于任何页面。';
  } else if (files.length <= 1) {
    note = '所有遮蔽特性均已关闭。';
  }

  if (nothingToDo) {
    await chrome.storage.local.set({
      [STATUS_KEY]: { ok: true, at: Date.now(), matches: [], files: [], note }
    });
    if (legacySites) await chrome.storage.local.set({ [CONFIG_KEY]: cfg });
    await refreshBadge();
    return;
  }

  const common = {
    matches,
    runAt: 'document_start',
    allFrames: true,
    // 关键:会话级注册。关掉浏览器,注册与 armed 列表一起消失,不留常驻能力。
    persistAcrossSessions: false,
    matchOriginAsFallback: true // 覆盖 about:blank / srcdoc 子框架,堵住跨 realm 取值
  };

  try {
    await chrome.scripting.registerContentScripts([
      Object.assign({ id: MAIN_ID, js: files, world: 'MAIN' }, common),
      Object.assign({ id: BRIDGE_ID, js: ['src/bridge.js'] }, common)
    ]);
    await chrome.storage.local.set({
      [STATUS_KEY]: { ok: true, at: Date.now(), matches, files, note }
    });
  } catch (e) {
    await chrome.storage.local.set({
      [STATUS_KEY]: { ok: false, error: String((e && e.message) || e), at: Date.now(), matches, files }
    });
  }
  if (legacySites) await chrome.storage.local.set({ [CONFIG_KEY]: cfg });
  await refreshBadge();
}

/** armed 里有、但因为缺权限没能进入 matches 的条目 */
function uniqNote(armed, matches) {
  const set = new Set(matches);
  return armed.some((a) => !set.has(a.pattern));
}

/* --------------------------------------------------------------- 操作 */

async function armTarget({ input, patterns, tabId }) {
  const list = Array.isArray(patterns) && patterns.length ? patterns.map(String) : toMatchPatterns(input);
  if (list.length === 0) return { ok: false, error: '网址无法识别,请填域名或完整网址' };

  const granted = await grantedOrigins();
  const missing = list.filter((p) => !isCovered(p, granted));
  if (missing.length) return { ok: false, error: '缺少源权限:' + missing.join(' , ') };

  const armed = await loadArmed();
  for (const p of list) {
    if (armed.some((a) => a.pattern === p)) continue;
    const parsed = parsePattern(p);
    armed.push({ pattern: p, host: parsed ? parsed.host : '', input: String(input || ''), at: Date.now() });
  }
  await saveArmed(armed);
  await sync();

  const reloaded = await reloadMatching(list, tabId);
  return { ok: true, armed: await loadArmed(), reloaded };
}

async function disarmTarget(pattern) {
  const armed = await loadArmed();
  const hit = armed.find((a) => a.pattern === pattern);
  await saveArmed(armed.filter((a) => a.pattern !== pattern));
  await sync();
  if (hit) await revokeOrigins([hit.pattern]);
  return { ok: true, armed: await loadArmed() };
}

async function disarmAll() {
  const armed = await loadArmed();
  await saveArmed([]);
  await sync();
  await revokeOrigins(armed.map((a) => a.pattern));
  return { ok: true, armed: [] };
}

/** 收回所有没被当前 armed 列表用到的源权限(含 v1 遗留的授权) */
async function revokeExtras() {
  const armed = await loadArmed();
  const keep = new Set(armed.map((a) => a.pattern));
  const granted = await grantedOrigins();
  const extra = granted.filter((g) => !keep.has(g));
  const removed = await revokeOrigins(extra);
  return { ok: true, removed };
}

async function revokeOrigins(origins) {
  const list = [...new Set((origins || []).filter(Boolean))];
  if (list.length === 0) return [];
  try {
    await chrome.permissions.remove({ origins: list });
    return list;
  } catch (_) {
    return [];
  }
}

/** 重新加载落在这些 pattern 内的标签页 —— 只有刷新才能拿到 document_start 时序 */
async function reloadMatching(patterns, tabId) {
  const ids = new Set();
  try {
    const tabs = await chrome.tabs.query({ url: patterns });
    for (const t of tabs || []) if (typeof t.id === 'number') ids.add(t.id);
  } catch (_) {
    /* 没有 tabs 权限时 url 过滤可能失败,退回只处理当前标签页 */
  }
  if (typeof tabId === 'number') {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && patterns.some((p) => urlMatchesPattern(tab.url, p))) ids.add(tabId);
    } catch (_) {}
  }
  let n = 0;
  for (const id of ids) {
    try {
      await chrome.tabs.reload(id);
      n++;
    } catch (_) {}
  }
  return n;
}

/** 「只注入当前页不刷新」:立刻生效,但抢不到 document_start —— 时序不可靠 */
async function injectNow({ tabId }) {
  if (typeof tabId !== 'number') return { ok: false, error: '拿不到标签页' };
  const { cfg } = await loadConfig();
  const files = mainWorldFiles(cfg.features);
  if (files.length <= 1) return { ok: false, error: '所有遮蔽特性均已关闭' };

  const errors = [];
  for (const allFrames of [true, false]) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames },
        world: 'MAIN',
        injectImmediately: true,
        files
      });
      break;
    } catch (e) {
      errors.push(String((e && e.message) || e));
    }
  }
  if (errors.length >= 2) return { ok: false, error: errors[errors.length - 1] };

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/bridge.js'] });
  } catch (_) {
    /* 桥失败只会影响运行时开关,补丁本身已经生效 */
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ 徽标 */

async function refreshBadge(tabId) {
  try {
    let tab;
    if (typeof tabId === 'number') tab = await chrome.tabs.get(tabId);
    else {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      tab = tabs && tabs[0];
    }
    if (!tab || !tab.url) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }
    const { cfg } = await loadConfig();
    const armed = await loadArmed();
    const on = cfg.enabled && armed.some((a) => urlMatchesPattern(tab.url, a.pattern));
    await chrome.action.setBadgeText({ text: on ? 'ON' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: on ? '#1f6f43' : '#666666' });
  } catch (_) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ 广播 */

/** 把最新配置推给已注入的标签页,让特性开关立即生效(注入范围变更仍需刷新) */
function broadcast(cfg) {
  chrome.tabs.query({}, (tabs) => {
    void chrome.runtime.lastError;
    for (const t of tabs || []) {
      if (typeof t.id !== 'number') continue;
      try {
        chrome.tabs.sendMessage(t.id, { type: 'pvg:config', config: cfg }, () => {
          void chrome.runtime.lastError; // 没有接收端(未注入)是正常情况
        });
      } catch (_) {}
    }
  });
}

/* -------------------------------------------------------------- 事件接线 */

chrome.runtime.onInstalled.addListener(() => sync());
chrome.runtime.onStartup.addListener(() => sync());
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'local' && changes[CONFIG_KEY]) || (area === 'session' && changes[ARMED_KEY])) sync();
});
chrome.permissions.onAdded.addListener(() => sync());
chrome.permissions.onRemoved.addListener(() => sync());
chrome.tabs.onActivated.addListener((info) => refreshBadge(info.tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' || changeInfo.url) refreshBadge(tabId);
});

/* --------------------------------------------------------------- 消息接口 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg.type !== 'string') {
      sendResponse({ ok: false, error: 'bad message' });
      return;
    }
    switch (msg.type) {
      case 'pvg:getState': {
        const bag = await chrome.storage.local.get(STATUS_KEY);
        let armedForTab = false;
        if (typeof msg.tabId === 'number') {
          try {
            const tab = await chrome.tabs.get(msg.tabId);
            const armed = await loadArmed();
            armedForTab = !!tab && armed.some((a) => urlMatchesPattern(tab.url, a.pattern));
          } catch (_) {}
        }
        sendResponse({
          ok: true,
          config: (await loadConfig()).cfg,
          armed: await loadArmed(),
          armedForTab,
          status: bag[STATUS_KEY] || null,
          granted: await grantedOrigins()
        });
        return;
      }
      case 'pvg:setConfig': {
        const cfg = await saveConfig(msg.config);
        await sync();
        broadcast(cfg);
        sendResponse({ ok: true, config: cfg });
        return;
      }
      case 'pvg:arm': {
        sendResponse(await armTarget(msg));
        return;
      }
      case 'pvg:disarm': {
        sendResponse(await disarmTarget(String(msg.pattern || '')));
        return;
      }
      case 'pvg:disarmAll': {
        sendResponse(await disarmAll());
        return;
      }
      case 'pvg:revokeExtras': {
        sendResponse(await revokeExtras());
        return;
      }
      case 'pvg:injectNow': {
        sendResponse(await injectNow(msg));
        return;
      }
      case 'pvg:sync': {
        await sync();
        sendResponse({ ok: true });
        return;
      }
      default:
        sendResponse({ ok: false, error: 'unknown type' });
    }
  })();
  return true; // 异步响应
});

sync();
