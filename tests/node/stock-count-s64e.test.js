import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const core=fs.readFileSync('apps/web/assets/js/stock-count-workspace.js','utf8');
const ext=fs.readFileSync('apps/web/assets/js/stock-count-l1-verified.js','utf8');
function extract(source,name){const start=source.indexOf('  function '+name+'(');assert.ok(start>=0);let end=source.indexOf('\n  function ',start+1);if(end<0)end=source.length;return source.slice(start,end);}
const ctx=vm.createContext({currentPermissions:()=>({can_edit:false}),sourceBadge:()=>'',statusPill:()=>'',formatDate:()=>'',UNIT_LABELS:{inventory:'Base unit',unit:'Unit'}});
for(const name of ['escapeHtml','number','formatNumber','lineCard'])vm.runInContext(extract(core,name),ctx);
for(const name of ['quantityFamily','previewNormalization','unitOptions'])vm.runInContext(extract(ext,name),ctx);
test('unknown baseline is labelled unknown and never generates zero variance',()=>{const html=ctx.lineCard({observed_quantity:0.8,expected_quantity:null,inventory_unit:'liters'});assert.match(html,/Unknown — no verified baseline/);assert.doesNotMatch(html,/\+0.8|No variance/);assert.equal(ctx.formatNumber(null),'Unknown');});
test('explicit observed and baseline zero retain no variance',()=>{assert.match(ctx.lineCard({observed_quantity:0,expected_quantity:0}),/No variance/);assert.equal(ctx.formatNumber(0),'0');});
test('empty quantity is not a zero count',()=>{assert.equal(ctx.previewNormalization({inventory_unit:'bottles'},'','inventory'),null);});
test('pieces cannot become boxes even with stale server options',()=>{const line={inventory_unit:'boxes',supported_count_units:['inventory','unit']};assert.equal(ctx.previewNormalization(line,8,'unit'),null);assert.doesNotMatch(ctx.unitOptions(line),/value="unit"/);assert.equal(ctx.previewNormalization(line,1,'inventory').normalized,1);});
test('two 400 ml containers convert to 0.8 liters',()=>{assert.equal(ctx.previewNormalization({inventory_unit:'liters',size_ml_snapshot:400},2,'unit').normalized,0.8);});
