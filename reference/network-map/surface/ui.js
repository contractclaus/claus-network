// Shared viewport behavior. Never intercept wheel, touch, keyboard or wallet input.
(() => {
  const page = document.body.dataset.ui;
  if (!page) return;
  // A focused field must remain reachable when the mobile keyboard opens.
  const viewport = window.visualViewport;
  if (viewport) {
    const resize = () => {
      if (viewport.scale !== 1) return;
      document.documentElement.style.setProperty('--ui-visible-height', `${viewport.height}px`);
      const input=document.activeElement,typing=page==='club'&&document.body.classList.contains('club-connected')&&input?.matches('textarea,input:not([type=button]):not([type=submit])');
      const inset=Math.max(0,innerHeight-viewport.height-viewport.offsetTop);
      document.body.classList.toggle('club-keyboard',!!typing&&inset>100);
      document.documentElement.style.setProperty('--ui-keyboard-inset',`${inset}px`);
    };
    viewport.addEventListener('resize', resize, {passive:true});
    viewport.addEventListener('scroll', resize, {passive:true});
    document.addEventListener('focusin',resize);
    document.addEventListener('focusout',()=>requestAnimationFrame(resize));
    resize();
  }
})();

// Keep NFT details in their bounded pane without adding header navigation.
(() => {
  if (document.body.dataset.ui !== 'nfts') return;
  const details = document.querySelector('.module-details');
  for (const element of document.querySelectorAll('.nft-explain, .nft-stats, .nft-source-links')) details?.append(element);
})();

// Keep the original account actions and their wallet/session handlers intact.
(() => {
  const footer = document.querySelector('.club-footer');
  if (!footer) return;
  const controls = [...document.querySelectorAll('header :is(#connect,#header-connect,#disconnect,#account,#access-keys)')];
  if (!controls.length) return;
  const account = document.createElement('nav');
  account.className = 'footer-account';
  account.setAttribute('aria-label', 'Account');
  const source = document.createElement('div');
  source.hidden = true;
  source.className = 'footer-account-source';
  source.append(...controls);
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'footer-wallet';
  trigger.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  const panel = document.createElement('div');
  panel.id = 'footer-account-panel';
  panel.className = 'footer-account-panel';
  panel.setAttribute('popover', 'auto');
  panel.setAttribute('aria-label', 'Account actions');
  trigger.setAttribute('popovertarget', panel.id);
  trigger.setAttribute('aria-controls', panel.id);
  account.append(source, trigger, panel);
  const inlineMount = document.querySelector('[data-wallet-account]');
  if (inlineMount) for (const control of controls) if (control.tagName === 'BUTTON') control.type = 'button';
  (inlineMount || footer).append(account);

  const original = id => document.getElementById(id);
  const actions = [];
  const addAction = (id, label, available) => {
    const target = original(id);
    if (!target) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => {
      panel.hidePopover();
      trigger.focus({preventScroll:true});
      target.click();
    });
    panel.append(button);
    actions.push({button, target, available});
  };
  addAction('account', 'Profile', target => !target.hidden);
  addAction('access-keys', 'MCP keys', target => !target.hidden);
  addAction('disconnect', 'Disconnect', target => !target.hidden);
  addAction('disconnect-entry', 'Log out', () => !original('account')?.hidden);

  const short = address => /^0x[\da-f]{40}$/i.test(address) ? `${address.slice(0,6)}…${address.slice(-4)}` : address;
  const addressFrom = control => {
    const content = [control.dataset.walletAddress, control.title, control.textContent].filter(Boolean).join(' ');
    return content.match(/0x[\da-f]{40}\b|0x[\da-f]{4,6}(?:…|\.{3})[\da-f]{4}\b/i)?.[0] ?? '';
  };
  const sync = () => {
    const current = controls.find(control => ['disconnect','account','access-keys'].includes(control.id) && !control.hidden && addressFrom(control));
    const address = current ? addressFrom(current) : '';
    if (!address && panel.matches(':popover-open')) panel.hidePopover();
    trigger.hidden = !address;
    trigger.textContent = short(address);
    trigger.setAttribute('aria-label', address ? `Account ${short(address)}` : 'Account');
    trigger.title = address;
    for (const {button, target, available} of actions) {
      button.hidden = !available(target);
      button.disabled = target.disabled;
    }
    if (panel.matches(':popover-open')) position();
  };
  const position = () => {
    const rect = trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    const height = viewport?.height ?? innerHeight;
    const width = viewport?.width ?? innerWidth;
    panel.style.right = `${Math.max(12, width - rect.right)}px`;
    if (inlineMount) {
      const top = Math.min(rect.bottom + 8, height - 64);
      panel.style.top = `${top}px`;
      panel.style.bottom = 'auto';
      panel.style.maxHeight = `${Math.max(44, height - top - 12)}px`;
      panel.style.transformOrigin = 'top right';
      return;
    }
    const bottomEdge = Math.min(rect.top - 10, footer.getBoundingClientRect().top, height - 12);
    panel.style.bottom = `${Math.max(12, innerHeight - bottomEdge)}px`;
    panel.style.maxHeight = `${Math.max(44, bottomEdge - 12)}px`;
    panel.style.setProperty('--account-origin-y', `${rect.top - bottomEdge}px`);
    panel.style.setProperty('--account-origin-x', `${rect.width / 2}px`);
  };
  panel.addEventListener('beforetoggle', event => {
    if (event.newState === 'open') position();
    trigger.setAttribute('aria-expanded', String(event.newState === 'open'));
  });
  panel.addEventListener('toggle', event => {
    if (event.newState === 'open') actions.find(action => !action.button.hidden && !action.button.disabled)?.button.focus({preventScroll:true});
  });
  const reposition = () => { if (panel.matches(':popover-open')) position(); };
  window.addEventListener('resize', reposition, {passive:true});
  if (inlineMount) window.addEventListener('scroll', reposition, {passive:true, capture:true});
  window.visualViewport?.addEventListener('resize', reposition, {passive:true});
  const observer = new MutationObserver(sync);
  observer.observe(source, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['hidden','disabled','title','data-wallet-address']});
  sync();
})();
