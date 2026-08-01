(function(){
  'use strict';

  const HISTORY_KEY='atlas_inventory_import_history_v1';
  const state={rows:[],file:null,existing:[],busy:false};
  const aliases={
    name:['name','item','item name','product','product name','ingredient'],
    category:['category','type','product category','group'],
    quantity:['quantity','qty','stock','current stock','qty in stock','on hand'],
    unit:['unit','uom','stock unit'],
    par_level:['par','par level','minimum stock','min stock','reorder point'],
    supplier:['supplier','vendor','primary supplier'],
    sku:['sku','barcode','item code','product code','ean'],
    bin_location:['storage','storage location','bin','bin location','shelf','shelf location'],
    units_per_case:['units per case','case size','pack size','units case'],
    case_cost:['case cost','case price','cost per case'],
    cost_price:['cost','cost price','unit cost','net cost','supplier cost'],
    discount_percent:['discount','discount %','discount percent','supplier discount']
  };

  const byId=id=>document.getElementById(id);
  const html=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const normalizedHeader=value=>String(value??'').trim().toLowerCase().replace(/[_-]+/g,' ').replace(/\s+/g,' ');
  const canonicalName=value=>String(value??'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/\b\d+(?:[.,]\d+)?\s*(?:ml|cl|l|ltr|litre|liter|g|kg|pcs?|pieces?|cans?|bottles?)\b/g,' ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
  const lower=value=>String(value??'').trim().toLowerCase();

  function parseNumber(value,money=false){
    if(value===null||value===undefined||value==='') return null;
    if(typeof value==='number') return Number.isFinite(value)?value:null;
    let raw=String(value).trim().replace(/\s/g,'').replace(/ISK/ig,'').replace(/[^0-9,.-]/g,'');
    if(!raw) return null;
    const comma=raw.lastIndexOf(',');
    const dot=raw.lastIndexOf('.');
    if(comma>-1&&dot>-1){
      const decimal=comma>dot?',':'.';
      const thousands=decimal===','?'.':',';
      raw=raw.split(thousands).join('').replace(decimal,'.');
    }else if(comma>-1){
      const decimals=raw.length-comma-1;
      raw=(money&&decimals===3)?raw.replace(/,/g,''):raw.replace(',','.');
    }else if(dot>-1&&money&&raw.length-dot-1===3){
      raw=raw.replace(/\./g,'');
    }
    const number=Number(raw);
    return Number.isFinite(number)?number:null;
  }

  function findValue(source,field){
    const map={};
    Object.keys(source||{}).forEach(key=>{map[normalizedHeader(key)]=source[key];});
    const candidates=[field.replace(/_/g,' '),...(aliases[field]||[])];
    for(const candidate of candidates){
      const key=normalizedHeader(candidate);
      if(Object.prototype.hasOwnProperty.call(map,key)&&map[key]!==''&&map[key]!==null&&map[key]!==undefined) return map[key];
    }
    return null;
  }

  function normalizeRow(source,index){
    const name=String(findValue(source,'name')??'').trim();
    const quantityRaw=findValue(source,'quantity');
    const parRaw=findValue(source,'par_level');
    const unitsRaw=findValue(source,'units_per_case');
    const caseCostRaw=findValue(source,'case_cost');
    const costRaw=findValue(source,'cost_price');
    const discountRaw=findValue(source,'discount_percent');
    return {
      _index:index+1,_source:source,_existing:null,_duplicateInFile:false,_action:'create',
      name,category:String(findValue(source,'category')??'').trim(),
      quantity:parseNumber(quantityRaw),quantityProvided:quantityRaw!==null,
      unit:String(findValue(source,'unit')??'').trim(),
      par_level:parseNumber(parRaw),parProvided:parRaw!==null,
      supplier:String(findValue(source,'supplier')??'').trim(),
      sku:String(findValue(source,'sku')??'').trim(),
      bin_location:String(findValue(source,'bin_location')??'').trim(),
      units_per_case:parseNumber(unitsRaw),unitsProvided:unitsRaw!==null,
      case_cost:parseNumber(caseCostRaw,true),caseCostProvided:caseCostRaw!==null,
      cost_price:parseNumber(costRaw,true),costProvided:costRaw!==null,
      discount_percent:parseNumber(discountRaw),discountProvided:discountRaw!==null
    };
  }

  function matchExisting(row,existing){
    const sku=lower(row.sku);
    if(sku){const match=existing.find(item=>lower(item.sku)===sku);if(match)return match;}
    const name=canonicalName(row.name);
    if(!name)return null;
    return existing.find(item=>canonicalName(item.name)===name)||null;
  }

  async function readWorkbook(file){
    if(!window.XLSX) throw new Error('Excel reader did not load. Refresh Atlas and try again.');
    const buffer=await file.arrayBuffer();
    const workbook=window.XLSX.read(buffer,{type:'array',cellDates:false});
    if(!workbook.SheetNames.length) throw new Error('The file contains no readable sheets.');
    const sheet=workbook.Sheets[workbook.SheetNames[0]];
    return window.XLSX.utils.sheet_to_json(sheet,{defval:'',raw:false});
  }

  async function fetchExisting(){
    const client=window.atlasSupabase;
    if(!client) throw new Error('Atlas is not connected to Supabase.');
    const {data,error}=await client.from('inventory_items').select('*').order('name',{ascending:true});
    if(error) throw error;
    return data||[];
  }

  async function prepareFile(file){
    setMessage('Reading '+file.name+'...');
    const [rawRows,existing]=await Promise.all([readWorkbook(file),fetchExisting()]);
    if(!rawRows.length) throw new Error('No data rows were found in the first sheet.');
    const seen=new Set();
    const rows=rawRows.map((source,index)=>normalizeRow(source,index));
    rows.forEach(row=>{
      const key=lower(row.sku)||canonicalName(row.name);
      if(!row.name){row._action='skip';return;}
      row._existing=matchExisting(row,existing);
      if(key&&seen.has(key)){row._duplicateInFile=true;row._action='skip';}
      else if(row._existing) row._action='merge';
      else row._action='create';
      if(key)seen.add(key);
    });
    state.rows=rows;state.file=file;state.existing=existing;
    byId('inventory-import-file-name').textContent=file.name;
    byId('inventory-import-file-meta').hidden=false;
    byId('inventory-import-preview').hidden=false;
    renderRows();renderSummary();setMessage('Preview ready. Nothing has been saved yet.','success');
    byId('inventory-import-preview').scrollIntoView({behavior:'smooth',block:'start'});
  }

  function renderRows(){
    const body=byId('inventory-import-rows');
    body.innerHTML=state.rows.map((row,index)=>{
      const match=row._duplicateInFile?'<span class="import-match duplicate">Duplicate in file</span>':row._existing?'<span class="import-match existing">'+html(row._existing.name)+'</span>':'<span class="import-match">New item</span>';
      const secondary=row.sku?'SKU '+html(row.sku):'Source row '+row._index;
      return '<tr><td>'+row._index+'</td><td><span class="import-product-name">'+html(row.name||'Unnamed row')+'</span><span class="import-secondary">'+secondary+'</span></td><td>'+html(row.category||'-')+'</td><td>'+html(row.quantityProvided?(row.quantity??'Invalid'):'-')+' '+html(row.unit||'')+'</td><td>'+html(row.supplier||'-')+'</td><td>'+match+'</td><td><select class="inventory-import-action" data-row="'+index+'" aria-label="Action for '+html(row.name||'row '+row._index)+'"><option value="merge" '+(row._action==='merge'?'selected':'')+' '+(!row._existing?'disabled':'')+'>Merge</option><option value="create" '+(row._action==='create'?'selected':'')+'>Create new</option><option value="skip" '+(row._action==='skip'?'selected':'')+'>Skip</option></select></td></tr>';
    }).join('');
    body.querySelectorAll('.inventory-import-action').forEach(select=>select.addEventListener('change',event=>{state.rows[Number(event.target.dataset.row)]._action=event.target.value;renderSummary();}));
  }

  function renderSummary(){
    const count=action=>state.rows.filter(row=>row._action===action).length;
    byId('inventory-import-total').textContent=state.rows.length;
    byId('inventory-import-new').textContent=count('create');
    byId('inventory-import-matches').textContent=count('merge');
    byId('inventory-import-skipped').textContent=count('skip');
  }

  function cleanPayload(row){
    return {
      name:row.name,
      category:row.category||'Other',
      quantity:row.quantityProvided&&row.quantity!==null?row.quantity:0,
      unit:row.unit||'units',
      par_level:row.parProvided?row.par_level:null,
      supplier:row.supplier||null,
      sku:row.sku||null,
      bin_location:row.bin_location||null,
      units_per_case:row.unitsProvided?row.units_per_case:null,
      case_cost:row.caseCostProvided?row.case_cost:null,
      cost_price:row.costProvided?row.cost_price:null,
      discount_percent:row.discountProvided&&row.discount_percent!==null?row.discount_percent:0
    };
  }

  function mergePayload(existing,row){
    const payload={};
    if(row.quantityProvided&&row.quantity!==null) payload.quantity=row.quantity;
    if(row.costProvided&&row.cost_price!==null) payload.cost_price=row.cost_price;
    if(row.caseCostProvided&&row.case_cost!==null) payload.case_cost=row.case_cost;
    if(row.discountProvided&&row.discount_percent!==null) payload.discount_percent=row.discount_percent;
    if(row.unitsProvided&&row.units_per_case!==null) payload.units_per_case=row.units_per_case;
    if(!existing.category&&row.category) payload.category=row.category;
    if(!existing.unit&&row.unit) payload.unit=row.unit;
    if(!existing.supplier&&row.supplier) payload.supplier=row.supplier;
    if(!existing.sku&&row.sku) payload.sku=row.sku;
    if(!existing.bin_location&&row.bin_location) payload.bin_location=row.bin_location;
    if(existing.par_level==null&&row.parProvided&&row.par_level!==null) payload.par_level=row.par_level;
    return payload;
  }

  async function commit(){
    if(state.busy)return;
    const selected=state.rows.filter(row=>row._action!=='skip');
    if(!selected.length){setMessage('Choose at least one row to create or merge.','error');return;}
    state.busy=true;toggleBusy(true);setProgress(0,'Starting import...');
    const client=window.atlasSupabase;
    const {data:userData}=await client.auth.getUser();
    const userId=userData?.user?.id||null;
    const result={created:0,merged:0,skipped:state.rows.length-selected.length,failed:0,errors:[]};
    for(let index=0;index<selected.length;index++){
      const row=selected[index];
      try{
        if(row._action==='merge'&&row._existing){
          const payload=mergePayload(row._existing,row);if(userId)payload.updated_by=userId;
          if(Object.keys(payload).length){const {error}=await client.from('inventory_items').update(payload).eq('id',row._existing.id);if(error)throw error;}
          result.merged++;
        }else{
          const payload=cleanPayload(row);if(userId)payload.updated_by=userId;
          const {error}=await client.from('inventory_items').insert(payload);if(error)throw error;
          result.created++;
        }
      }catch(error){result.failed++;result.errors.push('Row '+row._index+': '+error.message);}
      setProgress(Math.round(((index+1)/selected.length)*100),'Processing '+(index+1)+' of '+selected.length+'...');
    }
    saveHistory(result);renderHistory();
    try{if(typeof window.loadAll==='function')await window.loadAll();else if(typeof loadAll==='function')await loadAll();}catch(error){console.warn('Inventory refresh failed:',error);}
    setProgress(100,'Import complete. '+result.created+' created, '+result.merged+' merged, '+result.failed+' failed.');
    setMessage(result.failed?result.errors.slice(0,2).join(' | '):'Inventory updated successfully.',result.failed?'error':'success');
    if(typeof window.showToast==='function')window.showToast('Inventory import complete');
    state.busy=false;toggleBusy(false);
  }

  function setProgress(percent,label){byId('inventory-import-progress').hidden=false;byId('inventory-import-progress-label').hidden=false;byId('inventory-import-progress-bar').style.width=percent+'%';byId('inventory-import-progress-label').textContent=label;}
  function toggleBusy(busy){byId('inventory-import-commit').disabled=busy;byId('inventory-import-cancel').disabled=busy;byId('inventory-import-commit').textContent=busy?'Importing...':'Import selected rows';}
  function setMessage(message,type=''){const element=byId('inventory-import-message');element.textContent=message;element.className='import-message'+(type?' '+type:'');}

  function reset(){
    if(state.busy)return;
    state.rows=[];state.file=null;state.existing=[];
    byId('inventory-import-file').value='';byId('inventory-import-file-meta').hidden=true;byId('inventory-import-preview').hidden=true;byId('inventory-import-progress').hidden=true;byId('inventory-import-progress-label').hidden=true;setMessage('');
  }

  function saveHistory(result){
    const history=readHistory();history.unshift({file:state.file?.name||'Inventory import',date:new Date().toISOString(),...result});
    localStorage.setItem(HISTORY_KEY,JSON.stringify(history.slice(0,10)));
  }
  function readHistory(){try{return JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');}catch{return [];}}
  function renderHistory(){
    const history=readHistory();const container=byId('inventory-import-history');if(!container)return;
    if(!history.length){container.innerHTML='<p class="import-empty">No imports completed on this device yet.</p>';return;}
    container.innerHTML=history.map(entry=>'<div class="import-history-row"><div class="import-history-name"><strong>'+html(entry.file)+'</strong><span>'+new Date(entry.date).toLocaleString()+'</span></div><div class="import-history-stat"><strong>'+Number(entry.created||0)+'</strong><span>Created</span></div><div class="import-history-stat"><strong>'+Number(entry.merged||0)+'</strong><span>Merged</span></div><div class="import-history-stat"><strong>'+Number(entry.skipped||0)+'</strong><span>Skipped</span></div><div class="import-history-stat"><strong>'+Number(entry.failed||0)+'</strong><span>Failed</span></div></div>').join('');
  }

  function downloadTemplate(){
    const headers=['Name','Category','Quantity','Unit','Par Level','Supplier','SKU','Storage Location','Units per Case','Case Cost','Cost Price','Discount %'];
    const example=['Reyka Vodka','Vodka','6','bottles','4','Supplier name','123456789','Back bar shelf 2','6','24000','4000','0'];
    const csv=[headers,example].map(row=>row.map(value=>'"'+String(value).replace(/"/g,'""')+'"').join(',')).join('\n');
    const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));link.download='atlas-inventory-import-template.csv';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
  }

  function bind(){
    const drop=byId('inventory-import-drop'),input=byId('inventory-import-file');if(!drop||!input)return;
    const choose=()=>input.click();
    byId('inventory-import-browse').addEventListener('click',event=>{event.stopPropagation();choose();});
    byId('inventory-import-change-file').addEventListener('click',choose);drop.addEventListener('click',event=>{if(event.target.closest('button'))return;choose();});drop.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();choose();}});
    ['dragenter','dragover'].forEach(type=>drop.addEventListener(type,event=>{event.preventDefault();drop.classList.add('dragging');}));
    ['dragleave','drop'].forEach(type=>drop.addEventListener(type,event=>{event.preventDefault();drop.classList.remove('dragging');}));
    drop.addEventListener('drop',event=>{const file=event.dataTransfer.files?.[0];if(file)handle(file);});input.addEventListener('change',()=>{const file=input.files?.[0];if(file)handle(file);});
    byId('inventory-import-cancel').addEventListener('click',reset);byId('inventory-import-commit').addEventListener('click',commit);byId('download-import-template').addEventListener('click',downloadTemplate);renderHistory();
  }

  async function handle(file){
    const valid=/\.(xlsx|xls|csv)$/i.test(file.name);if(!valid){setMessage('Choose an .xlsx, .xls or .csv file.','error');return;}
    try{await prepareFile(file);}catch(error){console.error(error);setMessage(error.message,'error');}
  }

  window.AtlasImportCenter={render:renderHistory,reset};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);else bind();
})();
