(() => {
  'use strict';
  const root = document.documentElement;
  const controller = new AbortController();
  const bodyReady = document.body ? Promise.resolve() : new Promise(resolve =>
    document.addEventListener('DOMContentLoaded', resolve, {once:true}));
  let frame, state = 'pending', timer;
  const finish = value => {
    state = value;
    clearTimeout(timer);
    root.dataset.surfaceState = value;
    document.getElementById('surface-loading')?.remove();
    dispatchEvent(new Event('claus-page-ready'));
  };
  async function fallback() {
    if (state !== 'pending') return;
    state = 'recovering';
    clearTimeout(timer);
    controller.abort();
    frame?.remove();
    frame = null;
    await bodyReady;
    for (const node of document.querySelectorAll('script[data-classic-src]')) {
      const script = document.createElement('script');
      if (node.dataset.classicType) script.type = node.dataset.classicType;
      script.src = node.dataset.classicSrc;
      script.async = false;
      document.body.append(script);
    }
    finish('fallback');
  }
  const allowed = path => /^\/(?:Network|Home|Build|Lab|Hooks(?:\/[A-Za-z0-9-]+)?|Club|Swap|Transfer|Staking\/(?:Token|NFTs?|Withdraw)|Withdraw|Journal|Contract|Wallet|docs(?:\/[a-z0-9-]+)?|read\/[a-zA-Z0-9:/-]+|c\/[a-z0-9-]+(?:\/[a-zA-Z0-9._/-]+)?)(?:[?#][^\s]*)?$/.test(path) && !path.includes('..') && !path.includes('\\');
  addEventListener('message', event => {
    if (!frame || event.source !== frame.contentWindow || event.origin !== new URL(frame.src).origin) return;
    const data = event.data;
    if (data?.type === 'claus-surface-ready' && state === 'pending') {
      for (const node of [...document.body.children]) {
        if (node !== frame && node.tagName !== 'SCRIPT' && node.id !== 'claus-ink-transition') {
          node.hidden = true;
          node.inert = true;
        }
      }
      frame.classList.add('is-ready');
      finish('ready');
    }
    if (state === 'ready' && data?.type === 'claus-surface-navigate' && typeof data.path === 'string' && allowed(data.path)) {
      const link = document.createElement('a');
      link.href = data.path;
      link.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
      link.style.left = Math.max(0, Math.min(innerWidth, Number(data.x) || innerWidth / 2)) + 'px';
      link.style.top = Math.max(0, Math.min(innerHeight, Number(data.y) || innerHeight / 2)) + 'px';
      document.body.append(link);
      link.click();
      setTimeout(() => link.remove(), 1000);
    }
  });
  // Begin discovery in the head, before fallback styles and scripts finish loading.
  timer = setTimeout(fallback, 7000);
  fetch('/api/network-surface', {signal:controller.signal})
    .then(response => { if (!response.ok) throw Error('unavailable'); return response.json(); })
    .then(async data => {
      if (state !== 'pending') return;
      if (data.enabled !== true || !/^https:\/\/claus-network-surface-[a-z0-9-]+\.vercel\.app$/.test(data.url)) return fallback();
      await bodyReady;
      if (state !== 'pending') return;
      frame = document.createElement('iframe');
      frame.title = 'Claus Network';
      frame.className = 'claus-surface-frame';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
      frame.allow = 'clipboard-write';
      frame.referrerPolicy = 'no-referrer';
      frame.src = data.url + '/index.html' + location.hash;
      frame.addEventListener('error', fallback, {once:true});
      document.body.append(frame);
    }).catch(fallback);
})();
