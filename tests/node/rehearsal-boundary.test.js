import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../../apps/web/assets/js/rehearsal-boundary.js', import.meta.url),'utf8');
function runtime(config, online=true) {
  const requests=[]; const banner={setAttribute(){},style:{}};
  const window={VABAR_CONFIG:config,location:{origin:'https://rehearsal.example'},navigator:{onLine:online},
    fetch:async(...args)=>{requests.push(args);return 'sent';},addEventListener(){},
    document:{createElement:()=>banner,body:{prepend(){}},addEventListener(){}}};
  vm.runInNewContext(source,{window,document:window.document,URL,CustomEvent:class{}});
  return {window,requests,banner};
}
const config={MODE:'isolated-rehearsal',SUPABASE_URL:'https://atialqebqxcquzdkezln.supabase.co',SUPABASE_ANON_KEY:'sb_publishable_synthetic'};
test('rehearsal blocks live, branch and lookalike hosts before any request',async()=>{
  const {window,requests}=runtime(config);
  for(const host of ['dnefgcmjcgxlynycxkts.supabase.co','uhbamqetppqmygesoeeh.supabase.co','atialqebqxcquzdkezln.supabase.co.evil.test'])
    await assert.rejects(window.fetch(`https://${host}/rest/v1/recipes`));
  assert.equal(requests.length,0);
  assert.equal(await window.fetch(config.SUPABASE_URL+'/rest/v1/recipes'),'sent');
});
test('invalid rehearsal configuration fails closed including relative requests',async()=>{
  const {window,requests}=runtime({...config,SUPABASE_URL:'https://dnefgcmjcgxlynycxkts.supabase.co'});
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
