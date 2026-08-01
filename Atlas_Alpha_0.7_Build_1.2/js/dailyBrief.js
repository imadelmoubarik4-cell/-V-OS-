export function generateDailyBrief({inventory=[],recipes=[]}){
 const tasks=[];
 inventory.filter(i=>(i.currentStock||0)<(i.minimumStock||0))
   .forEach(i=>tasks.push({priority:'HIGH',text:`Order ${i.name}`}));
 recipes.filter(r=>r.margin&&r.margin<60)
   .forEach(r=>tasks.push({priority:'MED',text:`Review margin for ${r.name}`}));
 return tasks;
}
export function renderDailyBrief(tasks){
 document.getElementById('brief-date').textContent=new Date().toLocaleDateString();
 const ul=document.getElementById('brief-list');
 ul.innerHTML='';
 tasks.forEach(t=>{
   const li=document.createElement('li');
   li.textContent=`[${t.priority}] ${t.text}`;
   ul.appendChild(li);
 });
}