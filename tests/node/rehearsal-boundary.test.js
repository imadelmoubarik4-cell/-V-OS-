import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../../apps/web/assets/js/rehearsal-boundary.js', import.meta.url),'utf8');
function runtime(config, online=true) {
  const requests=[]; const banner={setAttribute(){},style:{}};
  const window={VABAR_CONFIG:config,location:{origin:'https://os-vabar.netlify.app'},navigator:{onLine:online},
    fetch:async(...args)=>{requests.push(args);return 'sent';},addEventListener(){},
    document:{createElement:()=>banner,body:{prepend(){}},addEventListener(){}}};
  vm.runInNewContext(source,{window,document:window.document,URL,CustomEvent:class{}});
  return {window,requests,banner};
}
const config={MODE:'production',SUPABASE_URL:'https://dnefgcmjcgxlynycxkts.supabase.co',SUPABASE_ANON_KEY:'sb_publishable_production'};
test('production blocks staging and lookalike hosts before any request',async()=>{
  const {window,requests}=runtime(config);
  for(const host of ['uhbamqetppqmygesoeeh.supabase.co','atialqebqxcquzdkezln.supabase.co','dnefgcmjcgxlynycxkts.supabase.co.evil.test'])
    await assert.rejects(window.fetch(`https://${host}/rest/v1/recipes`));
  assert.equal(requests.length,0);
  assert.equal(await window.fetch(config.SUPABASE_URL+'/rest/v1/recipes'),'sent');
});
test('invalid production configuration fails closed including relative requests',async()=>{
  const {window,requests}=runtime({...config,SUPABASE_URL:'https://atialqebqxcquzdkezln.supabase.co'});
  await assert.rejects(window.fetch('/anything')); assert.equal(requests.length,0);
});
test('offline POST is never sent or queued and loaded reads remain available',async()=>{
  const {window,requests,banner}=runtime(config,false);
  await assert.rejects(window.fetch(config.SUPABASE_URL+'/rest/v1/rpc/adjust_inventory',{method:'POST'}),/Offline/);
  assert.equal(requests.length,0); assert.match(banner.textContent,/Saves are paused/);
});
test('normal online configuration preserves the existing fetch destination',async()=>{
  const {window,requests}=runtime({SUPABASE_URL:'https://dnefgcmjcgxlynycxkts.supabase.co'});
  assert.equal(await window.fetch('https://dnefgcmjcgxlynycxkts.supabase.co/rest/v1/recipes'),'sent');
  assert.equal(requests.length,1);
});
test('production allows only the live voice offer endpoint on the voice service host',async()=>{
  const {window,requests}=runtime(config);
  assert.equal(await window.fetch('https://api.openai.com/v1/realtime/calls',{method:'POST'}),'sent');
  for(const url of ['https://api.openai.com/v1/responses','https://api.openai.com/v1/realtime/calls/rtc_1/hangup','https://api.openai.com/v1/realtime/calls?x=1','https://api.openai.com.evil.test/v1/realtime/calls'])
    await assert.rejects(window.fetch(url,{method:'POST'}));
  assert.equal(requests.length,1);
});
