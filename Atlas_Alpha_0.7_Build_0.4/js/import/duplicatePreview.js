export function detectDuplicates(rows, inventory=[]){
 const seen=new Set();
 return rows.map(r=>{
   const name=(r.name||r.Name||'').trim().toLowerCase();
   const exists=inventory.some(i=>(i.name||'').trim().toLowerCase()===name);
   const duplicate=seen.has(name)||exists;
   seen.add(name);
   return {...r,__duplicate:duplicate};
 });
}
