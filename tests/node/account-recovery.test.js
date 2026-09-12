import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../../apps/web/assets/js/account-recovery.js',import.meta.url),'utf8');
function page() {
  const elements=Object.fromEntries(['status','request-recovery','complete-recovery','recovery-email','new-password','confirm-password'].map(id=>[id,{value:'',hidden:false,handlers:{},button:{},querySelector(){return this.button;},addEventListener(event,fn){this.handlers[event]=fn;},reset(){this.value='';}}]));
  const calls=[]; let listener;
  const client={auth:{onAuthStateChange(fn){listener=fn;},async resetPasswordForEmail(email,options){calls.push({email,options});return {error:null};},async updateUser(value){calls.push(value);return {error:null};},async signOut(){calls.push('signOut');return {error:null};}}};
  vm.runInNewContext(source,{document:{getElementById:id=>elements[id]},window:{VABAR_CONFIG:{},AtlasRehearsalBoundary:{validate(){}},supabase:{createClient:()=>client}},location:{href:'https://isolated.example/recovery.html',pathname:'/recovery.html',hash:''},history:{replaceState(){}},URL,URLSearchParams});
  return {elements,calls,event:(name,session)=>listener(name,session),submit:id=>elements[id].handlers.submit({preventDefault(){}})};
}
test('reset request uses the same origin recovery page and neutral confirmation',async()=>{
  const p=page();p.elements['recovery-email'].value='staff@example.invalid';await p.submit('request-recovery');
  assert.equal(p.calls[0].options.redirectTo,'https://isolated.example/recovery.html');
  assert.match(p.elements.status.textContent,/If this email/);
});
test('ordinary sign-in cannot activate password reset; recovery event and matching password required',async()=>{
  const p=page();p.event('SIGNED_IN',{user:{}});p.elements['new-password'].value='long-test-password';p.elements['confirm-password'].value='long-test-password';
  await p.submit('complete-recovery');assert.equal(p.calls.length,0);
  p.event('PASSWORD_RECOVERY',{user:{}});p.elements['confirm-password'].value='different';
  await p.submit('complete-recovery');assert.equal(p.calls.length,0);
  p.elements['confirm-password'].value='long-test-password';await p.submit('complete-recovery');
  assert.equal(p.calls[0].password,'long-test-password');assert.equal(p.calls[1],'signOut');
  assert.equal(p.elements['complete-recovery'].hidden,true);
});
