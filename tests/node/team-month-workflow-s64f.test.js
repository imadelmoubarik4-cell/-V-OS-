import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
const team=fs.readFileSync(new URL('../../apps/web/assets/js/team-profiles.source.js',import.meta.url),'utf8');
const shifts=fs.readFileSync(new URL('../../apps/web/assets/js/shifts-workspace.js',import.meta.url),'utf8');
test('Team combines real accounts and manual roster without duplicating linked accounts',()=>{
 const fn=team.slice(team.indexOf('  function profiles()'),team.indexOf('  function profileById('));
 const scope={isManager:()=>true,state:{workspace:{profiles:[{id:'account',name:'Account'}]},roster:[{id:'linked',profile_id:'account'},{id:'manual',display_name:'New staff',active:true,default_role:'Bartender'}]}};
 vm.createContext(scope);vm.runInContext(fn,scope);const rows=scope.profiles();
 assert.equal(rows.length,2);assert.equal(rows[1].name,'New staff');assert.equal(rows[1].schedule_only,true);
});
test('Team shipped gzip bundle matches source',()=>{
 const bundle=fs.readFileSync(new URL('../../apps/web/assets/js/team-profiles.bundle.js.gz',import.meta.url));
 assert.equal(zlib.gunzipSync(bundle).toString(),team);
});
test('an invalid shift draft is kept in the editor for correction and never sent',()=>{
 // S88: the Month editor is the one Shifts editor (shifts-workspace.js). The
 // sheet stays open with the person, date, times and note the manager entered.
 const submit=shifts.slice(shifts.indexOf("    form.addEventListener('submit', async (event) => {"),shifts.indexOf('  async function removeShift(shift)'));
 assert.match(submit,/if \(!person \|\| !timesOk\) \{[\s\S]+?return;\s*\}[\s\S]+?mutate\('save-shift'/);
 assert.match(submit,/const timesOk = Boolean\(dateValue && startValue && endValue && startValue !== endValue\);/);
 assert.match(submit,/if \(ok\) closeLayer\(root\);\s*else \{/);
});
