// ==UserScript==
// @name         ChatGPT Sidebar Auto-Collapse + Turn Navigator
// @namespace    https://kundayang.dev
// @version      3.1.0
// @author       Liminal (yyygdhg)
// @homepageURL  https://github.com/yyygdhg/ai-thread-navigator
// @supportURL   https://github.com/yyygdhg/ai-thread-navigator/issues
// @downloadURL  https://raw.githubusercontent.com/yyygdhg/ai-thread-navigator/main/chatgpt-thread-navigator.user.js
// @updateURL    https://raw.githubusercontent.com/yyygdhg/ai-thread-navigator/main/chatgpt-thread-navigator.user.js
// @description  支持 ChatGPT、Claude、豆包：侧栏导航后自动收起；左侧波浪刻度、提问/回答预览与定位、本地书签。首次加载保留侧栏状态。
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://claude.ai/*
// @match        https://www.doubao.com/*
// @match        https://doubao.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// @license      MIT
// ==/UserScript==

// Copyright (c) 2026 Liminal (yyygdhg). MIT License.

(() => {
  'use strict';

  // 可编辑设置。无需 API Key、额外依赖或网络请求。
  const CONFIG = Object.freeze({
    autoCollapse: true,
    timeline: true,
    minViewportWidth: 600,  // 窄屏保留自动收栏，隐藏刻度以免遮住正文。
    jumpTo: 'assistant',   // 改成 'user' 可让刻度默认跳到提问。
    smoothScroll: true,
    bookmarks: true,
    refreshMs: 300,
    rowHeight: 16,
  });

  const HOST_ID = 'cgpt-thread-navigator';
  if (window.top !== window.self || document.getElementById(HOST_ID)) return;
  const SITE_HOST = location.hostname;
  const PLATFORMS = {
    chatgpt: {
      id: 'chatgpt',
      sidebar: '#app-shell-sidebar,#stage-slideover-sidebar,#stage-sidebar,#history,#sidebar,aside[role="navigation"],nav[aria-label="Chat history"],nav[aria-label="聊天记录"]',
      controls: 'button[aria-controls="app-shell-sidebar"],button[aria-controls="stage-slideover-sidebar"],button[aria-controls="stage-sidebar"],button[data-testid="close-sidebar-button"]',
      user: '[data-user-message-bubble],[data-message-author-role="user"],[data-chatgpt-search-unit-key$=":user"]',
      answer: '[data-chatgpt-search-unit-key$=":assistant"],[data-content-search-unit-key$=":assistant"],[data-message-author-role="assistant"]',
      root: '[data-thread-find-target="conversation"],[data-thread-user-message-navigation-content]',
      main: '', item: '[data-testid="create-new-chat-button"]',
      paths: /^\/(?:c\/|g\/|project\/|projects\/|$)/,
    },
    claude: {
      id: 'claude',
      sidebar: '.z-sidebar,aside,nav[aria-label="Sidebar"],nav[aria-label="Main navigation"],[data-testid="sidebar"]',
      controls: 'button[aria-controls*="sidebar" i],button[aria-label="Toggle sidebar" i],button[aria-label="Close sidebar" i],button[aria-label="Collapse sidebar" i],button[aria-label="Open sidebar" i]',
      user: '[data-testid="user-message"],[data-author="user"]',
      answer: '[data-testid="assistant-message"],[data-author="assistant"],.font-claude-response',
      root: '[data-autoscroll-container="true"]',
      main: '', item: '', paths: /^\/(?:chat\/|chats\/|new(?:\/|$)|$)/,
    },
    doubao: {
      id: 'doubao', sidebar: '#flow_chat_sidebar,[data-testid="flow_chat_sidebar"]',
      controls: '[data-testid="siderbar_close_btn"],[data-testid="siderbar_closed_status_btn"]',
      user: '[data-testid="send_message"]', answer: '[data-testid="receive_message"]',
      root: '[data-testid="message-list"]', main: '#chat-route-main',
      item: '[data-testid="chat_list_thread_item"],[data-testid="create_conversation_button"],[data-testid="conversation-list-item"]',
      paths: /^\/chat(?:\/|$)/,
    },
  };
  const PLATFORM = PLATFORMS[/^claude\.ai$/.test(SITE_HOST) ? 'claude' : /^(www\.)?doubao\.com$/.test(SITE_HOST) ? 'doubao' : 'chatgpt'];
  const SIDEBARS = PLATFORM.sidebar;
  const USER = PLATFORM.user;
  const ANSWER = PLATFORM.answer;
  const STORE = 'cgpt-turn-navigator:bookmarks:v1:';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const routeKey = () => location.pathname + location.search + location.hash;
  // 豆包可能在同一路径通过查询参数切换对话。ChatGPT 的原有书签键保持兼容。
  const conversationKey = (url = location) => url.pathname + (PLATFORM.id === 'doubao' ? url.search : '');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let route = routeKey();
  let pathname = conversationKey();
  let main = null;
  let conversation = null;
  let turns = [];
  const cache = new Map(); // 仅保留当前聊天已渲染过的短预览，不写入存储。
  let stars = readStars();
  let pendingNavigation = null;
  let collapseToken = 0;
  let refreshTimer = 0;
  let bindTimer = 0;
  let layoutFrame = 0;
  let activeFrame = 0;
  let hoverFrame = 0;
  let active = -1;
  let hovered = -1;
  let waveCenter = -1;
  let previousWave = -1;
  let railTop = 0;
  let latestPointerY = 0;
  let previewKind = 'pointer';
  let jumpToken = 0;

  function visible(el) {
    if (!el || !el.isConnected || el.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden';
  }

  // aria-expanded 是权威状态。避免点击“侧边栏选项”、打开按钮或隐藏副本。
  function expandedSidebar() {
    return Array.from(document.querySelectorAll(SIDEBARS)).find(el => {
      if (!visible(el)) return false;
      const rect = el.getBoundingClientRect();
      // 不把右侧 Artifact 面板或折叠后的窄轨误认为左侧聊天栏。
      return rect.width > 160 && rect.left < 80;
    }) || null;
  }

  function closeButton() {
    const known = Array.from(document.querySelectorAll(PLATFORM.controls)).filter(visible);
    const expanded = known.find(b => b.getAttribute('aria-expanded') === 'true');
    if (expanded) return expanded;
    const explicitlyClosing = known.find(b => !b.hasAttribute('aria-expanded') && (
      ['close-sidebar-button', 'siderbar_close_btn'].includes(b.getAttribute('data-testid')) || /^(关闭|隐藏|收起)侧(?:边)?栏|^(close|hide|collapse) (the )?sidebar/i.test(b.getAttribute('aria-label') || '')
    ));
    if (explicitlyClosing) return explicitlyClosing;
    const sidebar = expandedSidebar();
    const toggle = known.find(b => !b.hasAttribute('aria-expanded') && /^toggle sidebar$/i.test(b.getAttribute('aria-label') || ''));
    if (toggle && sidebar) return toggle;
    return Array.from(document.querySelectorAll('button[aria-label]')).find(b =>
      visible(b) && !b.hasAttribute('aria-haspopup') && b.getAttribute('aria-expanded') !== 'false' &&
      /^(关闭|隐藏|收起)侧(?:边)?栏$|^(close|hide|collapse) (the )?sidebar$/i.test(b.getAttribute('aria-label') || '')
    ) || null;
  }

  function collapseAfterNavigation() {
    const token = ++collapseToken;
    const targetRoute = route;
    // 只对一次明确的侧栏导航做有限重试；从不轮询侧栏状态。
    [140, 360, 800, 1500].forEach(delay => setTimeout(() => {
      if (token !== collapseToken || routeKey() !== targetRoute) return;
      const button = closeButton();
      if (!button) {
        // 已关闭则立即结束；用户之后主动展开时不能被后续重试再次收起。
        const closed = Array.from(document.querySelectorAll(PLATFORM.controls))
          .filter(visible);
        const isClosed = closed.length && closed.every(b => b.getAttribute('aria-expanded') === 'false' ||
          b.getAttribute('data-testid') === 'siderbar_closed_status_btn' || /^(显示|展开|打开)侧(?:边)?栏$|^open sidebar$/i.test(b.getAttribute('aria-label') || ''));
        const toggleClosed = closed.some(b => /^toggle sidebar$/i.test(b.getAttribute('aria-label') || '')) && !expandedSidebar();
        if (isClosed || toggleClosed) ++collapseToken;
        return;
      }
      ++collapseToken; // 一次导航最多点一次，即使框架延迟更新 aria-expanded。
      button.click();
      scheduleLayout();
    }, delay));
  }

  function checkRoute() {
    const next = routeKey();
    if (next === route) return;
    route = next;
    ++collapseToken;
    ++jumpToken;
    hidePreview();
    if (pathname !== conversationKey()) {
      pathname = conversationKey();
      cache.clear();
      turns = [];
      stars = readStars();
      render();
    }
    if (CONFIG.autoCollapse && pendingNavigation && Date.now() < pendingNavigation.expires &&
        (!pendingNavigation.expected || pendingNavigation.expected === conversationKey())) {
      pendingNavigation = null;
      collapseAfterNavigation();
    } else {
      pendingNavigation = null;
    }
    scheduleBind();
    scheduleRefresh();
  }

  document.addEventListener('click', event => {
    if (!CONFIG.autoCollapse || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!target?.closest(SIDEBARS)) return;
    const link = target.closest('a[href]');
    let expected = null;
    if (link) {
      if (link.target && link.target !== '_self' || link.hasAttribute('download')) return;
      const url = new URL(link.href, location.href);
      if (url.origin !== location.origin || conversationKey(url) === conversationKey() || !PLATFORM.paths.test(url.pathname)) return;
      expected = conversationKey(url);
    } else {
      const item = PLATFORM.item && target.closest(PLATFORM.item);
      const b = target.closest('button,[role="button"]');
      if (!item && (!b || !(/^(新聊天|新对话|New chat|Start new chat)$/i.test((b.textContent || b.getAttribute('aria-label') || '').trim()) ||
          b.getAttribute('data-testid') === 'create-new-chat-button'))) return;
    }
    const intent = { expected, expires: Date.now() + 7000 };
    pendingNavigation = intent;
    // 即使脚本处于隔离世界，点击后这些有限的 URL 检查也可以识别 SPA 导航。
    [0, 100, 300, 700, 1500, 3000, 6000].forEach(delay => setTimeout(() => {
      if (pendingNavigation === intent) checkRoute();
    }, delay));
    setTimeout(() => { if (pendingNavigation === intent) pendingNavigation = null; }, 7100);
  }, true);

  // 现代 Navigation API + 旧式 History；返回/前进更新刻度但不会强制收栏。
  if (window.navigation) window.navigation.addEventListener('currententrychange', checkRoute);
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    try {
      history[method] = function (...args) {
        const result = Reflect.apply(original, this, args);
        checkRoute();
        return result;
      };
    } catch (_) { /* 沙盒限制下使用点击、Navigation API 与页面事件。 */ }
  }
  addEventListener('popstate', checkRoute);
  addEventListener('hashchange', checkRoute);
  addEventListener('pageshow', () => { checkRoute(); scheduleBind(); });

  function readStars() {
    if (!CONFIG.bookmarks) return new Set();
    try {
      const value = JSON.parse(localStorage.getItem(STORE + conversationKey()) || '[]');
      return new Set(Array.isArray(value) ? value.filter(k => typeof k === 'string') : []);
    } catch (_) { return new Set(); }
  }

  function toggleStar() {
    const turn = turns[hovered];
    if (!turn || !CONFIG.bookmarks) return;
    stars.has(turn.key) ? stars.delete(turn.key) : stars.add(turn.key);
    try { localStorage.setItem(STORE + conversationKey(), JSON.stringify([...stars])); } catch (_) { /* 禁用存储时仍可在本次会话标记。 */ }
    paintBar(hovered);
    updatePreview();
  }

  function previewText(node, maxLength) {
    if (!node) return '';
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          return n.matches('button,svg,script,style,textarea,[hidden],[aria-hidden="true"],.sr-only,[data-markdown-copy="exclude"],[contenteditable="true"]')
            ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let text = '';
    let visited = 0;
    let n;
    while (text.length < maxLength && visited++ < 300 && (n = walker.nextNode())) {
      text += n.textContent.slice(0, maxLength - text.length) + ' ';
    }
    return text.replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }

  function collectTurns(root) {
    const result = [];
    if (PLATFORM.id !== 'chatgpt') {
      // Claude / 豆包分别渲染消息块。按照文档顺序配对，连续回答取最后一块。
      const selector = USER + ',' + ANSWER;
      const nodes = Array.from(root.querySelectorAll(selector)).filter(n => !n.parentElement.closest(selector));
      const occurrences = new Map();
      for (const node of nodes) {
        if (node.matches(USER)) {
          const owner = node.closest('[data-message-id],[data-msg-id]');
          const nativeId = owner?.getAttribute('data-message-id') || owner?.getAttribute('data-msg-id') || node.id;
          // 无公开 ID 的页面使用短文本哈希。书签不存储提问原文。
          let hash = 2166136261;
          for (const char of previewText(node, 220)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
          const digest = (hash >>> 0).toString(36);
          const occurrence = (occurrences.get(digest) || 0) + 1;
          occurrences.set(digest, occurrence);
          const key = `${PLATFORM.id}:${nativeId || `${digest}:${occurrence}`}`;
          result.push({ key, shell: node.closest('[data-test-render-count]') || node, user: node, assistant: null });
        } else if (result.length) {
          result[result.length - 1].assistant = node;
          result[result.length - 1].answerShell = node;
        }
      }
    } else {
    // 2026 app-shell 页面：一个 data-turn-key 包含一轮提问及对应回答。
    const modern = Array.from(root.querySelectorAll('[data-turn-key]')).filter(el => !el.parentElement.closest('[data-turn-key]'));
    if (modern.length) {
      for (const shell of modern) {
        result.push({ key: shell.getAttribute('data-turn-key'), shell, user: shell.querySelector(USER), assistant: shell.querySelector(ANSWER) });
      }
    } else {
      // 旧页面的持久 turn 壳；优先使用壳，避免虚拟化时刻度数量缩水。
      const shells = Array.from(root.querySelectorAll('[data-testid^="conversation-turn-"][data-turn],article[data-testid^="conversation-turn-"]'));
      const nodes = shells.length ? shells : Array.from(root.querySelectorAll('[data-message-author-role]'));
      for (const node of nodes) {
        const role = node.getAttribute('data-turn') || node.getAttribute('data-message-author-role') || node.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role');
        if (role === 'user') {
          const user = node.matches(USER) ? node : node.querySelector(USER);
          const key = user?.getAttribute('data-message-id') || node.getAttribute('data-message-id') || node.id || node.getAttribute('data-testid') || `turn-${result.length + 1}`;
          result.push({ key, shell: node, user: user || node, assistant: null });
        } else if (role === 'assistant' && result.length) {
          // 连续的多个 assistant 块归属同一提问；采用最后一个可读回答。
          const answer = node.matches(ANSWER) ? node : node.querySelector(ANSWER) || node;
          result[result.length - 1].assistant = answer;
          result[result.length - 1].answerShell = node;
        }
      }
    }
    }
    const keys = new Set();
    return result.filter(turn => {
      if (!turn.key || keys.has(turn.key)) return false;
      keys.add(turn.key);
      const old = { ...(cache.get(turn.key) || {}) };
      const prompt = previewText(turn.user, 220);
      const answer = previewText(turn.assistant, 520);
      const answerKey = turn.assistant?.getAttribute('data-chatgpt-search-message-ids') || turn.assistant?.getAttribute('data-message-id') || turn.assistant?.getAttribute('data-msg-id') || turn.assistant?.id;
      if (prompt && old.prompt && prompt !== old.prompt || answerKey && old.answerKey && answerKey !== old.answerKey) old.answer = '';
      turn.prompt = prompt || old.prompt || '提问尚未渲染，点击可定位';
      turn.answer = answer || old.answer || (turn.assistant ? '回答尚未渲染，点击可定位' : '等待回答…');
      cache.set(turn.key, { prompt: prompt || old.prompt, answer: answer || old.answer, answerKey: answerKey || old.answerKey });
      return true;
    });
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;inset:0 auto auto 0;width:0;height:0;z-index:2147483000;pointer-events:none;color-scheme:light dark';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host{--fg:#242424;--muted:#777;--card:rgba(249,249,249,.97);--border:rgba(0,0,0,.12);--shadow:0 8px 28px #0002;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
      :host([data-dark]){--fg:#eee;--muted:#999;--card:rgba(42,42,42,.97);--border:rgba(255,255,255,.12);--shadow:0 8px 28px #0005}
      [hidden]{display:none!important}*{box-sizing:border-box}
      button{font:inherit;color:inherit;cursor:pointer}button:focus-visible{outline:2px solid #769cea;outline-offset:3px}
      .rail{position:fixed;top:50%;transform:translateY(-50%);width:60px;pointer-events:auto;color:var(--fg)}
      .ticks{max-height:56vh;overflow-x:hidden;overflow-y:auto;scrollbar-width:none;overscroll-behavior:contain;padding:0;margin:0}.ticks::-webkit-scrollbar{display:none}
      .tick{display:flex;align-items:center;justify-content:flex-start;width:58px;height:${CONFIG.rowHeight}px;min-height:${CONFIG.rowHeight}px;border:0;background:transparent;padding:0 0 0 8px;position:relative;touch-action:pan-y}
      .line{display:block;width:9px;height:2px;flex:none;border-radius:1px;background:currentColor;transform:scaleX(var(--scale,1));transform-origin:left;opacity:var(--opacity,.3);transition:transform 100ms ease-out,opacity 100ms ease-out;pointer-events:none}
      .tick[data-star]::after{content:"";position:absolute;left:2px;width:3px;height:3px;border-radius:50%;background:#8baef0}
      .count{display:block;width:58px;text-align:left;padding:8px 0 0 6px;color:var(--muted);font-size:10px;opacity:0;transition:opacity 150ms;pointer-events:none}
      .rail:hover .count,.rail:focus-within .count{opacity:1}
      .card{position:fixed;width:440px;max-width:calc(100vw - 88px);padding:14px 16px 12px;border:1px solid var(--border);border-radius:17px;background:var(--card);box-shadow:var(--shadow);pointer-events:auto;color:var(--fg);backdrop-filter:blur(16px)}
      .meta{display:flex;align-items:center;justify-content:space-between;color:var(--muted);font-size:11px;margin-bottom:5px;gap:10px}
      .star{width:27px;height:27px;padding:4px;background:transparent;border:0;border-radius:6px;color:var(--muted)}.star:hover{background:#8882;color:var(--fg)}.star[aria-pressed="true"]{color:#8baef0}
      .star svg{width:17px;height:17px;display:block}.star[aria-pressed="true"] svg{fill:currentColor}
      .question,.answer{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;text-align:left;padding:0;background:none;border:none;width:100%;overflow-wrap:anywhere}
      .question{font-size:14px;font-weight:650;-webkit-line-clamp:2;line-height:1.5;margin:0 0 7px}.answer{font-size:13px;line-height:1.65;-webkit-line-clamp:4;color:var(--muted)}
      .question:hover,.answer:hover{color:var(--fg)}.hint{margin:9px 0 0;color:var(--muted);font-size:10px}
      .status{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:8px 14px;background:var(--card);color:var(--fg);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);pointer-events:none}
      @media(prefers-reduced-motion:reduce){.line,.count{transition:none}}
    </style>
    <nav class="rail" aria-label="对话轮次导航" hidden><div class="ticks"></div><span class="count"></span></nav>
    <section class="card" role="dialog" aria-label="这一轮的提问和回答" hidden>
      <div class="meta"><span class="position"></span><button class="star" type="button" aria-label="收藏这一轮" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 20V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v15l-6-4z"/></svg></button></div>
      <button class="question" type="button" title="定位到提问"></button>
      <button class="answer" type="button" title="定位到回答"></button>
      <p class="hint">点击刻度定位回答 · 点击标题定位提问</p>
    </section>
    <div class="status" role="status" aria-live="polite" hidden></div>`;
  document.body.append(host);
  const rail = shadow.querySelector('.rail');
  const ticks = shadow.querySelector('.ticks');
  const card = shadow.querySelector('.card');
  const status = shadow.querySelector('.status');
  let bars = [];
  let hideTimer = 0;
  let statusTimer = 0;

  function render() {
    const focusedKey = bars.find(b => b === shadow.activeElement)?.dataset.key;
    const fragment = document.createDocumentFragment();
    bars = turns.map((turn, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tick';
      b.dataset.key = turn.key;
      b.setAttribute('aria-label', `第 ${i + 1} 轮，定位到回答`);
      b.innerHTML = '<span class="line" aria-hidden="true"></span>';
      b.addEventListener('click', e => jump(i, e.shiftKey ? 'user' : CONFIG.jumpTo));
      b.addEventListener('focus', () => { previewKind = 'focus'; showPreview(i); });
      b.addEventListener('keydown', e => {
        let next = i;
        if (e.key === 'ArrowDown') next = Math.min(i + 1, bars.length - 1);
        else if (e.key === 'ArrowUp') next = Math.max(i - 1, 0);
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = bars.length - 1;
        else if (e.key === 'Escape') { hidePreview(); return; }
        else return;
        e.preventDefault();
        bars[next]?.focus({ preventScroll: true });
        bars[next]?.scrollIntoView({ block: 'nearest' });
      });
      fragment.append(b);
      return b;
    });
    ticks.replaceChildren(fragment);
    active = -1;
    hovered = -1;
    previousWave = -1;
    waveCenter = -1;
    shadow.querySelector('.count').textContent = `${turns.length} 轮`;
    bars.forEach((_, i) => paintBar(i));
    if (focusedKey) bars.find(b => b.dataset.key === focusedKey)?.focus({ preventScroll: true });
    scheduleLayout();
    scheduleActive();
  }

  function refresh() {
    refreshTimer = 0;
    checkRoute();
    if (!conversation?.isConnected) { scheduleBind(); return; }
    const next = collectTurns(conversation);
    const changed = next.length !== turns.length || next.some((t, i) => turns[i]?.key !== t.key);
    const currentKey = turns[hovered]?.key;
    turns = next;
    // 编辑或切换分支后只保留当前列表的预览，避免旧回答混入另一分支。
    const liveKeys = new Set(turns.map(t => t.key));
    for (const key of cache.keys()) if (!liveKeys.has(key)) cache.delete(key);
    if (changed) { hidePreview(); render(); }
    else if (!card.hidden && currentKey) updatePreview();
    scheduleLayout();
    scheduleActive();
  }

  function scheduleRefresh() {
    if (!refreshTimer) refreshTimer = setTimeout(refresh, CONFIG.refreshMs);
  }

  function paintBar(i) {
    const button = bars[i];
    if (!button) return;
    const distance = waveCenter < 0 ? Infinity : Math.abs(i - waveCenter);
    const influence = distance < 5 ? Math.exp(-distance * distance / 5) : 0;
    const width = Math.max(i === active ? 15 : 9, 9 + 33 * influence);
    button.style.setProperty('--scale', String(width / 9));
    button.style.setProperty('--opacity', String(i === active ? .95 : .28 + .7 * influence));
    button.toggleAttribute('data-active', i === active);
    button.toggleAttribute('data-star', stars.has(turns[i]?.key));
    if (i === active) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }

  function paintWave(center) {
    const affected = new Set([active]);
    for (const c of [previousWave, center]) if (c >= 0) {
      for (let i = Math.floor(c) - 5; i <= Math.ceil(c) + 5; i++) if (i >= 0 && i < bars.length) affected.add(i);
    }
    waveCenter = center;
    affected.forEach(paintBar);
    previousWave = center;
  }

  function updatePreview() {
    const turn = turns[hovered];
    if (!turn) { hidePreview(); return; }
    shadow.querySelector('.position').textContent = `第 ${hovered + 1} / ${turns.length} 轮`;
    shadow.querySelector('.question').textContent = turn.prompt;
    shadow.querySelector('.answer').textContent = turn.answer;
    const star = shadow.querySelector('.star');
    star.hidden = !CONFIG.bookmarks;
    star.setAttribute('aria-pressed', String(stars.has(turn.key)));
    star.setAttribute('aria-label', stars.has(turn.key) ? '取消收藏这一轮' : '收藏这一轮');
    placeCard();
  }

  function placeCard() {
    if (card.hidden || !bars[hovered]) return;
    const r = bars[hovered].getBoundingClientRect();
    card.style.width = `${Math.max(190, Math.min(440, innerWidth - r.left - 78))}px`;
    card.style.left = `${clamp(r.left + 64, 8, Math.max(8, innerWidth - card.offsetWidth - 8))}px`;
    card.style.top = `${clamp(r.top - 30, 10, Math.max(10, innerHeight - card.offsetHeight - 10))}px`;
  }

  function showPreview(i) {
    clearTimeout(hideTimer);
    if (!turns[i] || rail.hidden) return;
    hovered = i;
    card.hidden = false;
    updatePreview();
    if (previewKind === 'focus') paintWave(i);
  }

  function hidePreview() {
    clearTimeout(hideTimer);
    card.hidden = true;
    hovered = -1;
    paintWave(-1);
  }

  function delayHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!rail.matches(':hover') && !card.matches(':hover') && (previewKind === 'pointer' || !shadow.activeElement)) hidePreview();
    }, 180);
  }

  rail.addEventListener('pointerenter', () => { railTop = ticks.getBoundingClientRect().top; clearTimeout(hideTimer); });
  rail.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return;
    previewKind = 'pointer';
    latestPointerY = event.clientY;
    if (!hoverFrame) hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      const center = clamp((latestPointerY - railTop + ticks.scrollTop) / CONFIG.rowHeight - .5, 0, turns.length - 1);
      paintWave(center);
      showPreview(Math.round(center));
    });
  });
  ticks.addEventListener('scroll', () => { railTop = ticks.getBoundingClientRect().top; placeCard(); }, { passive: true });
  rail.addEventListener('pointerleave', delayHide);
  card.addEventListener('pointerenter', () => clearTimeout(hideTimer));
  card.addEventListener('pointerleave', delayHide);
  shadow.addEventListener('focusout', delayHide);
  shadow.addEventListener('keydown', e => { if (e.key === 'Escape') hidePreview(); });
  shadow.querySelector('.star').addEventListener('click', toggleStar);
  shadow.querySelector('.question').addEventListener('click', () => jump(hovered, 'user'));
  shadow.querySelector('.answer').addEventListener('click', () => jump(hovered, 'assistant'));

  function notify(message) {
    clearTimeout(statusTimer);
    status.textContent = message;
    status.hidden = false;
    statusTimer = setTimeout(() => { status.hidden = true; }, 2600);
  }

  function scrollContainer(node) {
    for (let p = node?.parentElement; p && p !== document.body; p = p.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight + 2) return p;
    }
    return document.scrollingElement;
  }

  function jump(i, kind) {
    const turn = turns[i];
    if (!turn) return;
    const key = turn.key;
    const token = ++jumpToken;
    const destination = () => {
      const current = turns.find(t => t.key === key);
      if (!current) return null;
      return (kind === 'user' ? current.user : current.assistant) ||
        (kind === 'assistant' ? current.answerShell : null) || current.shell;
    };
    const target = destination();
    if (!target?.isConnected) { scheduleRefresh(); notify('这轮对话已变化，请重新选择。'); return; }
    const scroller = scrollContainer(target);
    const scrollToTarget = (node, behavior) => {
      const r = node.getBoundingClientRect();
      const top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
      // 以相对位移滚动，同样支持新版 flex-col-reverse 的负 scrollTop。
      scroller.scrollBy({ top: r.top - top - 84, behavior });
    };
    scrollToTarget(target, CONFIG.smoothScroll && !reducedMotion.matches ? 'smooth' : 'instant');
    // 虚拟化重新挂载后，在一次有限的定位窗口内校准位置。
    [450, 950].forEach(delay => setTimeout(() => {
      if (token !== jumpToken) return;
      const mounted = destination();
      if (!mounted?.isConnected) return;
      const top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
      if (Math.abs(mounted.getBoundingClientRect().top - top - 84) > 36) scrollToTarget(mounted, 'instant');
      scheduleActive();
    }, delay));
    active = i;
    bars.forEach((_, index) => paintBar(index));
    if (target.animate && !reducedMotion.matches) target.animate([
      { outline: '2px solid transparent', outlineOffset: '6px' },
      { outline: '2px solid rgba(130,160,215,.5)', outlineOffset: '6px' },
      { outline: '2px solid transparent', outlineOffset: '6px' },
    ], { duration: 1000 });
    if (!turn.user || kind === 'assistant' && !turn.assistant) notify('已定位到这一轮。若正文还未显示，轻滚一下即可加载。');
    else if (kind === 'assistant' && turn.answer === '等待回答…') notify('这一轮暂时还没有回答。');
    hidePreview();
  }

  // 用户主动滚动时停止自动校准，避免把人拉回刚才的目标。
  for (const event of ['wheel', 'touchstart']) document.addEventListener(event, e => {
    if (!e.composedPath().includes(host)) ++jumpToken;
  }, { capture: true, passive: true });
  document.addEventListener('keydown', e => {
    if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(e.key) && !e.composedPath().includes(host)) ++jumpToken;
  }, true);

  function scheduleActive() {
    if (activeFrame) return;
    activeFrame = requestAnimationFrame(() => {
      activeFrame = 0;
      if (rail.hidden || !turns.length) return;
      const readingLine = Math.min(innerHeight * .3, 210);
      let next = 0;
      for (let i = 0; i < turns.length; i++) {
        const rect = turns[i].shell.getBoundingClientRect();
        if (rect.height > 0 && rect.top <= readingLine) next = i;
      }
      if (next !== active) { const prev = active; active = next; paintBar(prev); paintBar(active); }
    });
  }

  function scheduleLayout() {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      const r = main?.getBoundingClientRect();
      rail.hidden = !CONFIG.timeline || !turns.length || !r || innerWidth < CONFIG.minViewportWidth || r.width < 260;
      if (rail.hidden) hidePreview();
      else {
        rail.style.left = `${clamp(r.left + 4, 4, innerWidth - 66)}px`;
        railTop = ticks.getBoundingClientRect().top;
        placeCard();
      }
      const scheme = getComputedStyle(document.documentElement).colorScheme.trim();
      const dark = document.documentElement.classList.contains('dark') ||
        document.documentElement.getAttribute('data-theme') === 'dark' ||
        scheme === 'dark' || scheme.split(' ').includes('dark') &&
        matchMedia('(prefers-color-scheme: dark)').matches;
      host.toggleAttribute('data-dark', dark);
    });
  }

  const messageObserver = new MutationObserver(() => { checkRoute(); scheduleRefresh(); });
  const resizeObserver = new ResizeObserver(() => { scheduleLayout(); scheduleActive(); });
  function bind() {
    bindTimer = 0;
    checkRoute();
    main = document.querySelector('main') || document.querySelector('[role="main"]') ||
      (PLATFORM.main && document.querySelector(PLATFORM.main)) || document.querySelector(PLATFORM.root);
    const root = (main?.matches(PLATFORM.root) ? main : main?.querySelector(PLATFORM.root)) || main;
    if (root !== conversation) {
      messageObserver.disconnect();
      resizeObserver.disconnect();
      conversation = root;
      if (root) {
        messageObserver.observe(root, { childList: true, subtree: true, characterData: true,
          attributes: true, attributeFilter: ['data-turn-key', 'data-turn', 'data-message-author-role', 'data-chatgpt-search-unit-key', 'data-author', 'data-message-id', 'data-msg-id'] });
        resizeObserver.observe(root);
      }
      if (main && main !== root) resizeObserver.observe(main);
      const sidebar = document.querySelector(SIDEBARS);
      if (sidebar) resizeObserver.observe(sidebar);
      if (!root) { turns = []; render(); }
      scheduleRefresh();
    }
    scheduleLayout();
  }

  function scheduleBind() { if (!bindTimer) bindTimer = setTimeout(bind, 100); }
  // 外层只处理容器更换；聊天正文的文本变化交给上面的局部观察器。
  const shellObserver = new MutationObserver(records => {
    if (records.every(r => host.contains(r.target) || conversation?.contains(r.target))) return;
    checkRoute();
    if (!conversation?.isConnected || records.some(r => !r.target.closest?.(SIDEBARS))) scheduleBind();
    scheduleLayout();
  });
  shellObserver.observe(document.body, { childList: true, subtree: true });
  const themeObserver = new MutationObserver(scheduleLayout);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
  document.addEventListener('scroll', scheduleActive, { capture: true, passive: true });
  addEventListener('resize', () => { scheduleLayout(); scheduleActive(); }, { passive: true });
  bind(); // 初始只建立刻度，从不调用 collapseAfterNavigation。
})();
