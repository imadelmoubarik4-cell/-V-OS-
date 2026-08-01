export function matchInvoiceRows(invoiceRows, inventory){
 return invoiceRows.map(r=>{
   const match=inventory.find(i=>(i.sku&&i.sku===r.sku)||i.name?.toLowerCase()===r.name?.toLowerCase());
   return {...r,matched:!!match,inventoryId:match?.id||null};
 });
}
