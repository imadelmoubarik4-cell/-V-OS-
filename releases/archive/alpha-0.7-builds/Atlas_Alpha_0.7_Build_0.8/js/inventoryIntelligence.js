export function calculateInventoryMetrics(product){
  const usage = product.averageDailyUsage || 0;
  const stock = product.currentStock || 0;
  const par = product.parLevel || 0;

  return {
    currentStock: stock,
    averageDailyUsage: usage,
    daysRemaining: usage > 0 ? +(stock/usage).toFixed(1) : Infinity,
    recommendedOrder: Math.max(par-stock,0)
  };
}

export function renderInventoryIntelligence(product){
  const m = calculateInventoryMetrics(product);

  document.getElementById('ii-stock').textContent = m.currentStock;
  document.getElementById('ii-days').textContent = m.daysRemaining === Infinity ? '∞' : m.daysRemaining;
  document.getElementById('ii-usage').textContent = m.averageDailyUsage;
  document.getElementById('ii-order').textContent = m.recommendedOrder;

  const timeline=document.getElementById('movement-timeline');
  timeline.innerHTML='';
  (product.movements||[]).forEach(e=>{
    const li=document.createElement('li');
    li.textContent=`${e.date} — ${e.type} (${e.qty})`;
    timeline.appendChild(li);
  });

  const body=document.querySelector('#cost-history tbody');
  body.innerHTML='';
  (product.costHistory||[]).forEach(c=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${c.date}</td><td>${c.supplier}</td><td>${c.cost} ISK</td>`;
    body.appendChild(tr);
  });
}
