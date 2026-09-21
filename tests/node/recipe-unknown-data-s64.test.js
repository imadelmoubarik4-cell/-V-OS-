import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const ctx={window:{}};vm.runInNewContext(fs.readFileSync(new URL('../../apps/web/assets/js/atlas-calculations.js',import.meta.url),'utf8'),ctx);
const calc=ctx.window.AtlasCalculations;
const ingredient={item_id:'a',quantity:50,unit:'ml'};
const item={id:'a',size_ml:1000,cost_price:2000,quantity:999};
const recipe={recipe_ingredients:[ingredient],menu_price:1000,yield_quantity:1};
test('empty and missing-cost recipes do not report zero costs or false profit',()=>{
 for(const value of [calc.recipeMetrics({recipe_ingredients:[],menu_price:1000},[]),calc.recipeMetrics(recipe,[{...item,cost_price:null}])]){
  assert.equal(value.financials.total,null);assert.equal(value.financials.perServing,null);assert.ok(!Number.isFinite(value.financials.profit));assert.ok(!Number.isFinite(value.financials.margin));assert.ok(!Number.isFinite(value.financials.costPercent));
 }
});
test('mixed known and missing cost never presents partial sum as total',()=>{
 const r=calc.recipeMetrics({...recipe,recipe_ingredients:[ingredient,{...ingredient,item_id:'b'}]},[item,{...item,id:'b',cost_price:null}]);assert.equal(r.financials.total,null);assert.equal(r.financials.incomplete,1);
});
test('historical quantity does not establish stock; unknown suppresses alerts and servings',()=>{
 const r=calc.recipeMetrics(recipe,[{...item,quantity:0,par_level:10}]);assert.equal(r.availability.status,'incomplete');assert.equal(r.availability.servings,null);assert.equal(r.availability.belowPar,0);assert.equal(r.financials.total,100);
});
test('verified zero remains zero and a verified positive balance supports service',()=>{
 assert.equal(calc.recipeMetrics(recipe,[{...item,freshness_state:'current',verified_quantity:0}]).availability.status,'unavailable');
 assert.equal(calc.recipeMetrics(recipe,[{...item,freshness_state:'current',verified_quantity:2}]).availability.servings,40);
 assert.equal(calc.recipeMetrics(recipe,[{...item,freshness_state:'expired',verified_quantity:2}]).availability.servings,null);
});
test('unknown one-of-many stock makes overall coverage unknown',()=>{
 const r=calc.recipeMetrics({...recipe,recipe_ingredients:[ingredient,{...ingredient,item_id:'b'}]},[{...item,freshness_state:'current',verified_quantity:2},{...item,id:'b'}]);assert.equal(r.availability.servings,null);
});
test('missing sale price does not produce negative profit from null-to-zero conversion',()=>{const r=calc.recipeMetrics({...recipe,menu_price:null},[item]);assert.equal(r.financials.total,100);assert.ok(!Number.isFinite(r.financials.profit));});
