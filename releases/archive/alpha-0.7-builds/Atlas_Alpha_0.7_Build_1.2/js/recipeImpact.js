export function affectedRecipes(shortages=[],recipes=[]){
 const ids=new Set(shortages.map(s=>s.name));
 return recipes.filter(r=>(r.ingredients||[]).some(i=>ids.has(i.name)));
}