export function classifyRecipe(r){
 const margin=((r.price-r.cost)/Math.max(r.price,1))*100;
 let cls='Puzzle';
 if(margin>=70 && (r.sales||0)>=20) cls='Star';
 else if(margin>=70) cls='Plow Horse';
 else if((r.sales||0)>=20) cls='Challenge';
 else cls='Dog';
 return {...r,margin:+margin.toFixed(1),classification:cls};
}
export function renderMenuEngineering(recipes){
 const body=document.querySelector('#menu-table tbody');
 if(!body) return;
 body.innerHTML='';
 recipes.map(classifyRecipe).forEach(r=>{
   const tr=document.createElement('tr');
   tr.innerHTML=`<td>${r.name}</td><td>${r.cost}</td><td>${r.price}</td><td>${r.margin}</td><td>${r.classification}</td>`;
   body.appendChild(tr);
 });
}