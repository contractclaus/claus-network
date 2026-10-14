import {createAppClient} from './claus-app.js';
export const app=createAppClient(),status=document.querySelector('#status');
export const message=e=>{status.textContent=e.code==='sign_in_required'?'Use Sign in at the bottom of the Claus page.':e.code==='revision_conflict'?'This changed. Refresh before trying again.':e.code==='outcome_unknown_read_before_retry'?'The result is still unknown. Refresh before retrying.':e.message||'Could not finish this request.';};
export const node=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
export async function run(button,action){button.disabled=true;status.textContent='';try{await action();}catch(e){message(e);}finally{button.disabled=false;}}
export const requireSession=async()=>{const session=await app.call('session');if(!session.connected)throw Object.assign(Error('Sign in'),{code:'sign_in_required'});return session;};
