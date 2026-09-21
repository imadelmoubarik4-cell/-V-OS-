import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../../apps/web/assets/js/settings-workspace.js',import.meta.url),'utf8');
const render=source.slice(source.indexOf('  function render() {'),source.indexOf('  function applyPayload'));
test('Settings rendering settles under its class-attribute observer',()=>{
 const classes=new Set(); let queued=0, renders=0;
 const element={classList:{contains:c=>classes.has(c),add:c=>{classes.add(c);queued++;}},set innerHTML(v){renders++;}};
 const scope={host:()=>element,state:{loading:true,workspace:null},loadingMarkup:()=>'<p>Loading</p>',window:{}};
 vm.createContext(scope);vm.runInContext(render+'\nrender();',scope);
 for(let i=0;queued&&i<10;i++){queued--;vm.runInContext('render();',scope);}
 assert.equal(queued,0,'class observer must settle, not recursively trigger render');
 assert.equal(renders,2);
});
