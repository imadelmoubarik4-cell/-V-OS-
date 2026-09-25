import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../../apps/web/assets/js/recipes.js',import.meta.url),'utf8');
const save=source.slice(source.indexOf('  async function saveRecipe(event)'),source.indexOf('  function init()',source.indexOf('  async function saveRecipe(event)')));
function setup(rpcError,refreshError=false){
 const fields=new Map(); const field=id=>{if(!fields.has(id))fields.set(id,{value:id==='recipe-name'?'Manual recipe':id==='recipe-yield-qty'?'1':'',checked:false});return fields.get(id);};
 const button={disabled:false}, status={}; let closed=false,calls=0;
 const scope={canManageCommercial:()=>true,dom:{form:{querySelector:()=>button},saveState:status,categorySelect:{options:[{dataset:{slug:'other'}}],selectedIndex:0,value:''},modal:{}},document:{getElementById:field},currentUser:{id:'test'},state:{draftIngredients:[{item_name:'Manual',quantity:2,unit:'ml'}]},number:(v,d=0)=>Number(v)||d,sb:{rpc:async(name,payload)=>{calls++;assert.equal(name,'atlas_save_recipe');assert.equal(payload.p_ingredients[0].quantity,2);return {data:'persisted-id',error:rpcError};}},loadAll:async()=>{if(refreshError)throw Error('Refresh unavailable');},window:{AtlasModal:{close:()=>{closed=true;}}},activeView:'home',console:{error(){}}};
 vm.createContext(scope);vm.runInContext(save,scope);
 return {scope,field,button,status,get closed(){return closed;},get calls(){return calls;}};
}
test('failed recipe RPC keeps editor and draft available for retry',async()=>{
 const s=setup({message:'Save unavailable'});await s.scope.saveRecipe({preventDefault(){}});
 assert.equal(s.calls,1);assert.equal(s.closed,false);assert.equal(s.button.disabled,false);assert.equal(s.status.textContent,"The recipe couldn't be saved. Nothing was changed. Try again.");assert.equal(s.scope.state.draftIngredients.length,1);
});
test('committed recipe retains identity if refresh fails, preventing duplicate retry',async()=>{
 const s=setup(null,true);await s.scope.saveRecipe({preventDefault(){}});
 assert.equal(s.field('recipe-id').value,'persisted-id');assert.match(s.status.textContent,/^Saved\. The recipe list couldn't refresh/);assert.equal(s.closed,false);assert.equal(s.button.disabled,false);
});
