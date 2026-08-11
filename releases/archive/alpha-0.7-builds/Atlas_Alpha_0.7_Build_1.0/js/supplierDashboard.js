export function supplierStats(supplier, purchases=[]){
 const rows=purchases.filter(p=>p.supplier===supplier);
 const spend=rows.reduce((t,r)=>t+(r.total||0),0);
 const avg=rows.length?rows.reduce((t,r)=>t+(r.deliveryDays||0),0)/rows.length:0;
 return {orders:rows.length,totalSpend:spend,averageDelivery:+avg.toFixed(1)};
}

export function renderSupplierDashboard(supplier, products, purchases){
 const stats=supplierStats(supplier.name,purchases);
 document.getElementById('supplier-name').textContent=supplier.name;
 document.getElementById('supplier-spend').textContent=`${stats.totalSpend} ISK`;
 document.getElementById('supplier-orders').textContent=stats.orders;
 document.getElementById('supplier-delivery').textContent=`${stats.averageDelivery} days`;

 const body=document.querySelector('#supplier-products tbody');
 body.innerHTML='';
 products.filter(p=>p.supplier===supplier.name).forEach(p=>{
   const tr=document.createElement('tr');
   tr.innerHTML=`<td>${p.name}</td><td>${p.unitCost} ISK</td><td>${p.lastPurchase||'-'}</td>`;
   body.appendChild(tr);
 });
}
