// A single ink handoff for document navigation. Run in the head before first paint.
(() => {
  const key = 'claus-page-arrival';
  const lastPageKey = 'claus-last-page';
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let arrival = null, leaving = false, generation = 0, watchdog = 0;
  const aliases = {'/':'/Network','/Home':'/Network','/home':'/Network','/network':'/Network','/swap':'/Swap','/swap.html':'/Swap','/Withdraw':'/Staking/Withdraw','/legacy-exit':'/Staking/Withdraw','/Staking':'/Staking/Token','/Staking/CLAUS':'/Staking/Token','/Staking/NFTs':'/Staking/NFT','/Splash':'/Staking/Token','/splash':'/Staking/Token','/Liquidity':'/Staking/Token','/liquidity':'/Staking/Token','/nfts':'/Staking/NFT','/Hooks/NFTs':'/Staking/NFT'};
  const route = url => (aliases[url.pathname] || url.pathname) + url.search;
  const isStaking = url => ['/Staking/Token','/Staking/NFT','/Staking/Withdraw'].includes(aliases[url.pathname] || url.pathname);
  function fromStaking() {
    try { const previous = sessionStorage.getItem(lastPageKey) || document.referrer; return isStaking(location) && isStaking(new URL(previous, location.href)); } catch { return false; }
  }
  let stakingArrival = false;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
    sessionStorage.removeItem(key);
    if (saved && route(new URL(saved.path, location.href)) === route(location) && Date.now() - saved.at >= 0 && Date.now() - saved.at < 15000 &&
        Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      if (saved.kind === 'staking') stakingArrival = true;
      else arrival = saved;
    }
  } catch { /* Storage is optional; links remain native without it. */ }
  const navigationType = performance.getEntriesByType('navigation')[0]?.type;
  let internalArrival = false;
  try { internalArrival = navigationType === 'navigate' && new URL(document.referrer).origin === location.origin; } catch {}
  if (!reduced.matches && !stakingArrival && !fromStaking() && (arrival || internalArrival || navigationType === 'back_forward')) {
    arrival ||= {x: .5, y: .5};
    root.dataset.pageArrival = '';
  } else arrival = null;

  function reset() {
    generation++;
    clearTimeout(watchdog);
    leaving = false;
    arrival = null;
    delete root.dataset.pageArrival;
    window.ClausInk?.instance?.cancel();
  }
  // A document arrives at its own landmark, never an unrelated old screen corner.
  function destinationPoint() {
    for (const selector of ['#world-claus', '.staking-switch [aria-current="page"]', 'body[data-ui="swap"] .swap-heading h1.ui-page-title', '.claus-page:not([hidden]) h1.ui-page-title', '.claus-page:not([hidden]) .page-heading h1', 'main h1', '#atlas-main h1', 'a[aria-label="Claus Network"]']) {
      const element = document.querySelector(selector);
      const box = element?.getBoundingClientRect();
      if (box?.width && box?.height && box.bottom > 0 && box.top < innerHeight) {
        return {x: box.left + box.width / 2, y: box.top + box.height / 2};
      }
    }
    return {x: innerWidth / 2, y: innerHeight / 2};
  }
  function reveal() {
    if (!arrival || !document.body) return;
    const point = destinationPoint();
    arrival = null;
    clearTimeout(watchdog);
    // reveal() paints an opaque frame synchronously before dropping the head veil.
    const animation = window.ClausInk?.mount().reveal(point);
    delete root.dataset.pageArrival;
    animation?.catch(reset);
  }
  window.ClausPageTransition = {reveal, reset, destinationPoint};
  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('stage')) requestAnimationFrame(reveal);
    else watchdog = setTimeout(reveal, 1500);
  }, {once:true});

  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey ||
        event.altKey || event.shiftKey || link.hasAttribute('download') ||
        link.target && link.target !== '_self' || reduced.matches || !window.ClausInk) return;
    const target = new URL(link.href, location.href);
    if (target.origin !== location.origin || !/^https?:$/.test(target.protocol)) return;
    if (/\.(?:txt|json|xml|zip|pdf|svg|png|jpe?g|webp|gif|mp4|webm)$/i.test(target.pathname) || target.pathname.startsWith('/api/')) return;
    if (target.href === location.href) { event.preventDefault(); return; }
    if (route(target) === route(location)) return;
    if (isStaking(location) && isStaking(target)) {
      try { sessionStorage.setItem(key, JSON.stringify({kind:'staking',path:route(target),at:Date.now(),x:.5,y:.5})); } catch {}
      return; // Native document handoff retains the complete wallet module.
    }
    event.preventDefault();
    if (leaving) return;
    reset();
    leaving = true;
    const own = generation;
    const rect = link.getBoundingClientRect();
    const point = {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    watchdog = setTimeout(reset, 10000);
    const navigate = () => {
      if (own !== generation) return;
      try { sessionStorage.setItem(key, JSON.stringify({path:route(target),at:Date.now(),x:point.x/innerWidth,y:point.y/innerHeight})); } catch {}
      location.assign(target.href);
    };
    void window.ClausInk.mount().leave(point, navigate).catch(() => {
      if (own === generation) { reset(); location.assign(target.href); }
    });
  });
  addEventListener('pagehide', () => {
    try { sessionStorage.setItem(lastPageKey, location.href); } catch {}
  });
  addEventListener('pageshow', event => {
    if (!event.persisted) return;
    reset();
    if (!reduced.matches && !fromStaking()) {
      arrival = {x:.5,y:.5};
      root.dataset.pageArrival = '';
      reveal();
    }
  });
  addEventListener('keydown', event => {
    if (event.key === 'Escape' && leaving) reset();
  });
  reduced.addEventListener('change', () => { if (reduced.matches) reset(); });
})();
