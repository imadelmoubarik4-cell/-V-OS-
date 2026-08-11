export function generateRecommendations({inventory=[],recipes=[]}){
 const recs=[];
 inventory.filter(i=>(i.currentStock||0)<(i.minimumStock||0))
   .forEach(i=>recs.push({type:'PURCHASE',message:`Reorder ${i.name}`}));
 recipes.filter(r=>((r.price-r.cost)/Math.max(r.price,1))*100<60)
   .forEach(r=>recs.push({type:'MARGIN',message:`Review pricing for ${r.name}`}));
 return recs;
}