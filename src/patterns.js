'use strict';

/*
 * patterns.js — URL / host 与 match pattern 的唯一实现
 *
 * 同时被 popup/options(classic script)和 background(ES module 里副作用导入)使用,
 * 所以这里不写 export,统一挂到 globalThis.PVGPatterns。
 */

(() => {
  const root = globalThis;

  // 'example.com' -> ['*://example.com/*']
  // '*.example.com' -> ['*://*.example.com/*']
  // 'https://a.b.com:8443/x' -> ['https://a.b.com/*']  (match pattern 不支持端口与路径)
  function toMatchPatterns(raw) {
    let s = String(raw || '').trim().toLowerCase();
    if (!s) return [];
    s = s.replace(/^\/+|\/+$/g, '');
    let scheme = '*';
    const m = /^([a-z][a-z0-9+.-]*):\/\//.exec(s);
    if (m) {
      scheme = m[1];
      s = s.slice(m[0].length);
    }
    s = s.split('/')[0].split('?')[0];
    s = s.replace(/:\d+$/, '');
    s = s.replace(/^\[|\]$/g, '');
    if (!s) return [];
    if (scheme === 'file') return ['file:///*'];
    if (!/^(\*\.)?[a-z0-9._-]+$/.test(s) && !/^[0-9a-f:]+$/.test(s)) return [];
    return [`${scheme}://${s}/*`];
  }

  function parsePattern(pattern) {
    const m = /^(\*|https?|file|ftp):\/\/([^/]+)\//.exec(String(pattern || ''));
    if (!m) return null;
    return { scheme: m[1], host: m[2].toLowerCase() };
  }

  /** granted 中的模式能否覆盖 need */
  function isCovered(need, granted) {
    if (!Array.isArray(granted) || granted.length === 0) return false;
    if (granted.includes('<all_urls>') || granted.includes('*://*/*')) return true;
    const want = parsePattern(need);
    if (!want) return false;
    for (const g of granted) {
      const have = parsePattern(g);
      if (!have) continue;
      if (have.scheme !== '*' && want.scheme !== '*' && have.scheme !== want.scheme) continue;
      if (have.host === want.host) return true;
      if (have.host.startsWith('*.') && want.host.endsWith(have.host.slice(1))) return true;
      if (want.host.startsWith('*.')) return true;
    }
    return false;
  }

  /** 白名单条目是否匹配某个实际 hostname */
  function hostMatches(entryHost, host) {
    const e = String(entryHost || '').toLowerCase();
    const h = String(host || '').toLowerCase();
    if (!e || !h) return false;
    if (e === h) return true;
    if (e.startsWith('*.')) return h === e.slice(2) || h.endsWith(e.slice(1));
    return false;
  }

  /** 一个具体 URL 是否落在某个 match pattern 内(用于判断「这个标签页是否已被武装」) */
  function urlMatchesPattern(url, pattern) {
    if (!url) return false;
    const p = parsePattern(pattern);
    if (!p) return false;
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return false;
    }
    if (p.scheme === 'file') return u.protocol === 'file:';
    if (p.scheme !== '*' && u.protocol !== p.scheme + ':') return false;
    return hostMatches(p.host, u.hostname);
  }

  root.PVGPatterns = { toMatchPatterns, parsePattern, isCovered, hostMatches, urlMatchesPattern };
})();
