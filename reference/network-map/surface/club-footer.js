// Reuse the Home eye tracker; only animate while a pointer movement is settling.
(()=>{
 const root=document.querySelector('.club-footer');if(!root)return;
 const reduced=matchMedia('(prefers-reduced-motion: reduce)'),tracker=window.ClausEyes.create(root);
 const letters=[];
 function collectLetters(){const known=new Set(letters.map(eye=>eye.el));for(const el of document.querySelectorAll('[data-club-eye]'))if(!known.has(el))letters.push({el,cx:+el.dataset.cx,cy:+el.dataset.cy,x:0,y:0});}
 collectLetters();
 addEventListener('claus:art-ready',()=>{collectLetters();refresh();});
 function updateLetters(delta){
  const amount=reduced.matches?1:1-Math.exp(-delta/70);let moving=false;
  const visible=letters.flatMap(eye=>{const matrix=eye.el.getClientRects().length&&eye.el.parentElement.getScreenCTM();return matrix&&matrix.a*matrix.d-matrix.b*matrix.c?[{eye,matrix}]:[];});
  for(const {eye,matrix} of visible){
   const local=pointer&&!reduced.matches?new DOMPoint(pointer.x,pointer.y).matrixTransform(matrix.inverse()):{x:eye.cx,y:eye.cy},dx=local.x-eye.cx,dy=local.y-eye.cy,distance=Math.hypot(dx,dy)||1,reach=Math.min(1,distance/180);
   const x=dx/distance*22*reach,y=dy/distance*24*reach;
   eye.x+=(x-eye.x)*amount;eye.y+=(y-eye.y)*amount;
   eye.el.setAttribute('transform',`translate(${eye.x.toFixed(3)} ${eye.y.toFixed(3)})`);
   moving ||= Math.hypot(x-eye.x,y-eye.y)>.025;
  }
  return moving;
 }
 let pointer=null,frame=0,last=0;
 function tick(now){frame=0;if(document.hidden)return;const delta=last?Math.min(now-last,40):16,moving=tracker.update(pointer,delta,reduced.matches),lettersMoving=updateLetters(delta);last=now;if(moving||lettersMoving)frame=requestAnimationFrame(tick);}
 function refresh(){if(!frame&&!document.hidden){last=0;frame=requestAnimationFrame(tick);}}
 addEventListener('pointermove',e=>{if(e.pointerType!=='mouse'&&e.pointerType!=='pen')return;pointer={x:e.clientX,y:e.clientY};refresh();},{passive:true});addEventListener('scroll',refresh,{passive:true,capture:true});addEventListener('claus:view',refresh);addEventListener('resize',refresh,{passive:true});
 function rest(){pointer=null;refresh();}
 addEventListener('blur',rest);document.addEventListener('pointerleave',rest);reduced.addEventListener('change',refresh);
 document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(frame);frame=0;}else refresh();});refresh();
 const trigger=root.querySelector('.onchain-trigger'),panel=root.querySelector('[popover]');
 function position(opening=false){
  if(!opening&&!panel.matches(':popover-open'))return;
  const r=trigger.getBoundingClientRect(),gap=12;
  // Resolve placement before the opening paint; no centre-to-anchor jump.
  const width=panel.offsetWidth||parseFloat(getComputedStyle(panel).width)||244;
  const left=Math.max(16,Math.min(innerWidth-width-16,r.x+r.width/2-width/2));
  panel.style.left=left+'px';panel.style.bottom=Math.max(16,innerHeight-r.top+gap)+'px';
  panel.style.maxHeight=Math.max(100,r.top-28)+'px';
  panel.style.setProperty('--onchain-origin-x',(r.x+r.width/2-left)+'px');
 }
 panel.addEventListener('beforetoggle',e=>{if(e.newState==='open')position(true);});
 panel.addEventListener('toggle',e=>{trigger.setAttribute('aria-expanded',String(e.newState==='open'));});
 panel.addEventListener('click',e=>{if(e.target.closest('a'))panel.hidePopover();});addEventListener('resize',()=>position(),{passive:true});addEventListener('scroll',()=>position(),{passive:true});
 const copy=root.querySelector('.contract-copy'),status=root.querySelector('.copy-status');let reset;
 copy.addEventListener('click',async()=>{clearTimeout(reset);try{await navigator.clipboard.writeText(copy.dataset.address);copy.dataset.copied='true';delete status.dataset.error;status.textContent='Contract address copied';reset=setTimeout(()=>{delete copy.dataset.copied;status.textContent='';},1800);}catch{status.dataset.error='true';status.textContent='Could not copy. Please try again.';}});
})();
