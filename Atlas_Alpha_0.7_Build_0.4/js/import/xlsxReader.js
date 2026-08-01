// Atlas Alpha 0.7 - XLSX Reader Adapter
// Requires SheetJS (xlsx) to be loaded globally as XLSX.
export async function readXLSX(file){
  const buffer=await file.arrayBuffer();
  const wb=XLSX.read(buffer,{type:'array'});
  const ws=wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws,{defval:''});
}
