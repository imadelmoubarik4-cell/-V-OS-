export function renderPreview(container,items){
 if(!items.length){container.innerHTML='<p>No data</p>';return;}
 const cols=Object.keys(items[0]);
 let html='<table><thead><tr>'+cols.map(c=>`<th>${c}</th>`).join('')+'</tr></thead><tbody>';
 for(const item of items){
   html+='<tr>'+cols.map(c=>`<td>${item[c]??''}</td>`).join('')+'</tr>';
 }
 html+='</tbody></table>';
 container.innerHTML=html;
}
