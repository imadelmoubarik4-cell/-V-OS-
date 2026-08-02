export async function readCSV(file){
 const text=await file.text();
 const rows=text.trim().split(/\r?\n/).map(r=>r.split(","));
 const headers=rows.shift();
 return rows.map(r=>Object.fromEntries(headers.map((h,i)=>[h.trim(),(r[i]||'').trim()])));
}
