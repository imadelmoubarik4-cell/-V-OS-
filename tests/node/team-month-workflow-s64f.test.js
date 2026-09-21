import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
const team=fs.readFileSync(new URL('../../apps/web/assets/js/team-profiles.source.js',import.meta.url),'utf8');
const month=fs.readFileSync(new URL('../../apps/web/assets/js/shifts-month-calendar.js',import.meta.url),'utf8');
test('Team combines real accounts and manual roster without duplicating linked accounts',()=>{
 const fn=team.slice(team.indexOf('  function profiles()'),team.indexOf('  function selectedProfile()'));
 const scope={state:{workspace:{profiles:[{id:'account',name:'Account'}]},roster:[{id:'linked',profile_id:'account'},{id:'manual',display_name:'New staff',active:true,default_role:'Bartender'}]}};
 vm.createContext(scope);vm.runInContext(fn,scope);const rows=scope.profiles();
 assert.equal(rows.length,2);assert.equal(rows[1].name,'New staff');assert.equal(rows[1].schedule_only,true);
});
test('Team shipped gzip bundle matches source',()=>{
 const bundle=fs.readFileSync(new URL('../../apps/web/assets/js/team-profiles.bundle.js.gz',import.meta.url));
 assert.equal(zlib.gunzipSync(bundle).toString(),team);
});
test('invalid Month draft retains employee, dates and note for correction',()=>{
 const fn=month.slice(month.indexOf('  function submitShift(form)'),month.indexOf('  function navigateToWeek'));
 const values={starts_local:'2026-09-23T18:00',ends_local:'2026-09-23T17:00',person_id:'new-staff',note:'Keep this',role_name:'Bartender',shift_id:'',break_minutes:'0'};
 let rendered=0;
 const scope={state:{monthStart:'2026-09-01',modal:{mode:'shift'}},formValue:(_,name)=>values[name]||'',renderPanel:()=>rendered++,mutate:()=>assert.fail('invalid draft must not send')};
 vm.createContext(scope);vm.runInContext(fn,scope);scope.submitShift({});
 assert.equal(rendered,1);assert.equal(scope.state.modal.shift.person_id,'new-staff');assert.equal(scope.state.modal.shift.note,'Keep this');assert.match(scope.state.error,/after/);
});
