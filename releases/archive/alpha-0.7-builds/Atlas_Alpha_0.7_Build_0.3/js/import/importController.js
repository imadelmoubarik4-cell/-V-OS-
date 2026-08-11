import {readCSV} from './csvReader.js';
import {renderPreview} from './importPreview.js';

export function initImportCenter(){
 const input=document.getElementById('import-file');
 const preview=document.getElementById('import-preview');
 if(!input||!preview)return;
 input.addEventListener('change',async()=>{
   const file=input.files[0];
   if(!file)return;
   if(file.name.toLowerCase().endsWith('.csv')){
      const items=await readCSV(file);
      renderPreview(preview,items);
   }else{
      preview.innerHTML='<p>XLSX support will be added with SheetJS integration.</p>';
   }
 });
}
