export function generatePurchaseOrder(inventory){
  return inventory
    .filter(i => (i.currentStock||0) < (i.parLevel||0))
    .map(i => ({
      supplier: i.supplier,
      product: i.name,
      current: i.currentStock,
      par: i.parLevel,
      suggested: (i.parLevel||0) - (i.currentStock||0)
    }));
}

export function renderPurchaseOrder(rows){
  const body=document.querySelector('#po-table tbody');
  if(!body) return;
  body.innerHTML='';
  rows.forEach(r=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${r.supplier}</td>
<td>${r.product}</td>
<td>${r.current}</td>
<td>${r.par}</td>
<td>${r.suggested}</td>`;
    body.appendChild(tr);
  });
}

export function exportPurchaseOrderCSV(rows){
  const headers=['Supplier','Product','Current','Par','Suggested'];
  const csv=[headers.join(',')].concat(
    rows.map(r=>[r.supplier,r.product,r.current,r.par,r.suggested].join(','))
  ).join('\n');

  const blob=new Blob([csv],{type:'text/csv'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='purchase-order.csv';
  a.click();
}
