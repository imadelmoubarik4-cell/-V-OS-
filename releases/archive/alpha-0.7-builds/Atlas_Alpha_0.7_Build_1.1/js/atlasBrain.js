export function analyzeInventory(inventory=[]){
  return {
    lowStock: inventory.filter(i=>(i.currentStock||0)<=(i.minimumStock||0)),
    reorder: inventory.filter(i=>(i.currentStock||0)<(i.parLevel||0))
      .map(i=>({name:i.name,qty:(i.parLevel||0)-(i.currentStock||0)})),
    topConsumption:[...inventory]
      .sort((a,b)=>(b.averageDailyUsage||0)-(a.averageDailyUsage||0))
      .slice(0,10),
    marginRisks: inventory.filter(i=>(i.margin||100)<60)
  };
}

export function renderAtlasBrain(report){
  const fill=(id,rows,fmt)=>{
    const el=document.getElementById(id);
    if(!el) return;
    el.innerHTML='';
    rows.forEach(r=>{
      const li=document.createElement('li');
      li.textContent=fmt(r);
      el.appendChild(li);
    });
  };

  fill('brain-alerts',report.lowStock,r=>`${r.name} (${r.currentStock})`);
  fill('brain-orders',report.reorder,r=>`${r.name} → ${r.qty}`);
  fill('brain-consumption',report.topConsumption,r=>`${r.name} (${r.averageDailyUsage||0}/day)`);
  fill('brain-margins',report.marginRisks,r=>`${r.name} (${r.margin||0}%)`);
}
