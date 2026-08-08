(function(){
  'use strict';

  const BUCKET='atlas-imports';
  const MAX_FILE_SIZE=50*1024*1024;
  const TERMINAL=new Set(['completed','completed_with_review','imported','failed','cancelled']);
  const COMPLETE=new Set(['completed','completed_with_review','imported']);
  const ALLOWED_EXTENSIONS=new Set(['pdf','xlsx','xls','csv','json','txt','jpg','jpeg','png','webp','heic','heif']);
  const STAGES=['uploaded','reading','extracting','matching','ready','importing'];
  const SCOPE_LABELS={inventory:'Inventory',recipe:'Recipes',supplier:'Suppliers',menu:'Menus',invoice:'Invoices',purchase:'Purchases',image:'Images'};
  const STATUS_LABELS={prepared:'Prepared',uploaded:'Uploaded',reading:'Reading',extracting:'Extracting',matching:'Matching',ready:'Ready for review',importing:'Importing',completed:'Completed',completed_with_review:'Completed with review',imported:'Imported',failed:'Failed',cancelled:'Cancelled'};

  const state={batches:[],filter:'all',query:'',loading:false,selectedId:null,pollTimer:null,localUploads:new Map()};
  const byId=id=>document.getElementById(id);
  const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

  function getClient(){
    if(!window.atlasSupabase) throw new Error('Atlas is not connected to Supabase. Sign in and try again.');
    return window.atlasSupabase;
  }

  function notify(message,type=''){
    const el=byId('import-queue-message');
    if(el){el.textContent=message;el.className='import-message'+(type?' '+type:'');}
    if(type==='success'&&typeof window.showToast==='function') window.showToast(message);
  }

  function formatBytes(bytes){
    const value=Number(bytes||0);
    if(!value)return '0 B';
    const units=['B','KB','MB','GB'];
    const index=Math.min(Math.floor(Math.log(value)/Math.log(1024)),units.length-1);
    return (value/Math.pow(1024,index)).toFixed(index?1:0)+' '+units[index];
  }

  function formatDate(value){
    if(!value)return '—';
    const date=new Date(value);
    return Number.isNaN(date.getTime())?'—':date.toLocaleString([], {dateStyle:'medium',timeStyle:'short'});
  }

  function extensionOf(name){
    const parts=String(name||'').split('.');
    return parts.length>1?parts.pop().toLowerCase():'';
  }

  function mimeFor(file){
    if(file.type)return file.type;
    const ext=extensionOf(file.name);
    return ({pdf:'application/pdf',csv:'text/csv',txt:'text/plain',json:'application/json',xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif'})[ext]||'application/octet-stream';
  }

  function safeFileName(name){
    return String(name||'source-file').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9._-]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,140)||'source-file';
  }

  function activeStage(batch){
    if(batch.status==='failed'||batch.status==='cancelled')return batch.status;
    if(COMPLETE.has(batch.status))return 'complete';
    return batch.current_stage||batch.status||'uploaded';
  }

  function statusLabel(batch){
    const stage=activeStage(batch);
    return STATUS_LABELS[stage]||STATUS_LABELS[batch.status]||String(stage||'Uploaded').replace(/_/g,' ');
  }

  function statusClass(batch){
    const stage=activeStage(batch);
    return stage==='complete'?'completed':stage;
  }

  function progressOf(batch){
    if(COMPLETE.has(batch.status))return 100;
    return Math.max(0,Math.min(100,Number(batch.progress_percent||0)));
  }

  function sourceName(batch){
    return batch.file_name||batch.source_files?.[0]||'Untitled source';
  }

  function filterBatches(){
    const query=state.query.trim().toLowerCase();
    return state.batches.filter(batch=>{
      const status=batch.status||'uploaded';
      let pass=true;
      if(state.filter==='active')pass=!TERMINAL.has(status)&&status!=='ready';
      else if(state.filter==='uploaded')pass=status==='uploaded'||status==='prepared';
      else if(state.filter==='ready')pass=status==='ready';
      else if(state.filter==='complete')pass=COMPLETE.has(status);
      else if(state.filter==='failed')pass=status==='failed'||status==='cancelled';
      if(!pass)return false;
      if(!query)return true;
      const haystack=[sourceName(batch),batch.entity_scope,batch.mime_type,batch.notes,batch.last_error,status].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }

  function renderSummary(){
    const batches=state.batches;
    byId('import-queue-total').textContent=batches.length;
    byId('import-queue-active').textContent=batches.filter(b=>!TERMINAL.has(b.status)&&b.status!=='ready').length;
    byId('import-queue-ready').textContent=batches.filter(b=>b.status==='ready').length;
    byId('import-queue-complete').textContent=batches.filter(b=>COMPLETE.has(b.status)).length;
    byId('import-queue-failed').textContent=batches.filter(b=>b.status==='failed'||b.status==='cancelled').length;
  }

  function fileIcon(batch){
    const ext=(batch.file_extension||extensionOf(sourceName(batch))).toLowerCase();
    if(['jpg','jpeg','png','webp','heic','heif'].includes(ext))return 'image';
    if(ext==='pdf')return 'file-text';
    if(['xlsx','xls','csv'].includes(ext))return 'sheet';
    return 'file';
  }

  function actionButton(action,icon,label,id){
    return '<button type="button" class="import-row-action" data-import-action="'+action+'" data-batch-id="'+id+'" title="'+label+'" aria-label="'+label+'"><i data-lucide="'+icon+'"></i></button>';
  }

  function renderQueue(){
    const rows=filterBatches();
    const body=byId('import-queue-rows');
    const empty=byId('import-queue-empty');
    if(!body||!empty)return;
    empty.hidden=rows.length>0||state.loading;
    body.innerHTML=rows.map(batch=>{
      const progress=progressOf(batch);
      const name=sourceName(batch);
      const scope=SCOPE_LABELS[batch.entity_scope]||batch.entity_scope||'Inventory';
      const canRetry=batch.status==='failed'||batch.status==='cancelled';
      const canCancel=!TERMINAL.has(batch.status)&&batch.status!=='ready';
      return '<tr>'+
        '<td><div class="import-file-cell"><div class="import-file-icon"><i data-lucide="'+fileIcon(batch)+'"></i></div><div class="import-file-copy"><strong>'+escapeHtml(name)+'</strong><span>'+escapeHtml(formatBytes(batch.file_size))+' · '+escapeHtml(batch.file_extension||extensionOf(name).toUpperCase()||'FILE')+'</span></div></div></td>'+
        '<td><span class="import-scope-pill">'+escapeHtml(scope)+'</span></td>'+
        '<td><span class="import-status-pill '+escapeHtml(statusClass(batch))+'">'+escapeHtml(statusLabel(batch))+'</span></td>'+
        '<td><div class="import-progress-cell"><div class="import-progress-meta"><span>'+escapeHtml(batch.current_stage||batch.status||'uploaded')+'</span><strong>'+progress+'%</strong></div><div class="import-progress-track"><div style="width:'+progress+'%"></div></div></div></td>'+
        '<td>'+escapeHtml(formatDate(batch.created_at))+'</td>'+
        '<td><div class="import-row-actions">'+actionButton('open','panel-right-open','Open batch',batch.id)+(canRetry?actionButton('retry','rotate-ccw','Retry',batch.id):'')+(canCancel?actionButton('cancel','circle-x','Cancel',batch.id):'')+actionButton('delete','trash-2','Delete',batch.id)+'</div></td>'+
      '</tr>';
    }).join('');
    if(window.lucide)window.lucide.createIcons();
  }

  function renderAll(){renderSummary();renderQueue();}

  async function loadQueue(showLoading=true){
    if(state.loading)return;
    state.loading=true;
    if(showLoading)byId('import-queue-loading').hidden=false;
    try{
      const {data,error}=await getClient().from('import_batches').select('*').order('created_at',{ascending:false}).limit(100);
      if(error)throw error;
      state.batches=data||[];
      renderAll();
      notify('');
      if(state.selectedId){const selected=state.batches.find(b=>b.id===state.selectedId);if(selected)renderDetails(selected);else closeDetails();}
    }catch(error){
      console.error(error);
      notify(error.message||'Could not load the import queue.','error');
    }finally{
      state.loading=false;
      byId('import-queue-loading').hidden=true;
      renderQueue();
    }
  }

  function localUploadRow(key,file,status,type=''){
    state.localUploads.set(key,{file,status,type});
    const container=byId('import-upload-list');
    if(!container)return;
    container.innerHTML=[...state.localUploads.entries()].map(([id,item])=>'<div class="import-upload-row" data-local-id="'+escapeHtml(id)+'"><div><strong>'+escapeHtml(item.file.name)+'</strong><span>'+escapeHtml(formatBytes(item.file.size))+'</span></div><div class="import-upload-state '+escapeHtml(item.type||'')+'">'+escapeHtml(item.status)+'</div></div>').join('');
  }

  function validateFile(file){
    const ext=extensionOf(file.name);
    if(!ALLOWED_EXTENSIONS.has(ext))throw new Error(file.name+': unsupported file type.');
    if(file.size>MAX_FILE_SIZE)throw new Error(file.name+': file exceeds the 50 MB limit.');
    if(file.size===0)throw new Error(file.name+': file is empty.');
  }

  async function uploadOne(file,scope){
    validateFile(file);
    const client=getClient();
    const {data:{user},error:userError}=await client.auth.getUser();
    if(userError)throw userError;
    if(!user)throw new Error('Your session has expired. Sign in again.');
    const localKey=crypto.randomUUID();
    localUploadRow(localKey,file,'Creating queue record…');
    const batchKey='upload-'+new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14)+'-'+crypto.randomUUID();
    const ext=extensionOf(file.name);
    const insertPayload={
      batch_key:batchKey,
      source_files:[file.name],
      file_name:file.name,
      file_extension:ext||null,
      mime_type:mimeFor(file),
      file_size:file.size,
      entity_scope:scope,
      status:'uploaded',
      current_stage:'uploading',
      progress_percent:5,
      created_by:user.id,
      record_counts:{},
      notes:'Uploaded from Atlas Import Center.'
    };
    const {data:batch,error:insertError}=await client.from('import_batches').insert(insertPayload).select('*').single();
    if(insertError)throw insertError;
    state.batches.unshift(batch);
    renderAll();
    const now=new Date();
    const directory=[now.getUTCFullYear(),String(now.getUTCMonth()+1).padStart(2,'0'),String(now.getUTCDate()).padStart(2,'0')].join('/');
    const storagePath=user.id+'/'+directory+'/'+batch.id+'-'+safeFileName(file.name);
    try{
      localUploadRow(localKey,file,'Uploading…');
      await client.from('import_batches').update({storage_bucket:BUCKET,storage_path:storagePath,current_stage:'uploading',progress_percent:20,started_at:new Date().toISOString(),last_error:null}).eq('id',batch.id);
      const {error:uploadError}=await client.storage.from(BUCKET).upload(storagePath,file,{cacheControl:'3600',upsert:false,contentType:mimeFor(file)});
      if(uploadError)throw uploadError;
      const {data:updated,error:updateError}=await client.from('import_batches').update({status:'uploaded',current_stage:'uploaded',progress_percent:100,storage_bucket:BUCKET,storage_path:storagePath,last_error:null}).eq('id',batch.id).select('*').single();
      if(updateError)throw updateError;
      state.batches=state.batches.map(item=>item.id===batch.id?updated:item);
      localUploadRow(localKey,file,'Queued','success');
      renderAll();
      return updated;
    }catch(error){
      console.error(error);
      const message=error.message||'Upload failed.';
      await client.from('import_batches').update({status:'failed',current_stage:'failed',last_error:message}).eq('id',batch.id);
      localUploadRow(localKey,file,'Failed','error');
      await loadQueue(false);
      throw new Error(file.name+': '+message);
    }
  }

  async function handleFiles(fileList){
    const files=[...fileList];
    if(!files.length)return;
    const scope=byId('import-entity-scope').value||'inventory';
    byId('import-queue-file-input').value='';
    let completed=0;
    const errors=[];
    notify('Uploading '+files.length+' '+(files.length===1?'file':'files')+'…');
    for(const file of files){
      try{await uploadOne(file,scope);completed++;}
      catch(error){errors.push(error.message);}
    }
    if(completed)notify(completed+' '+(completed===1?'file':'files')+' added to the import queue.','success');
    if(errors.length)notify(errors.join(' '),'error');
    await loadQueue(false);
  }

  async function updateBatch(id,payload,successMessage){
    const {data,error}=await getClient().from('import_batches').update(payload).eq('id',id).select('*').single();
    if(error)throw error;
    state.batches=state.batches.map(batch=>batch.id===id?data:batch);
    renderAll();
    if(state.selectedId===id)renderDetails(data);
    if(successMessage)notify(successMessage,'success');
    return data;
  }

  async function retryBatch(batch){
    await updateBatch(batch.id,{status:'uploaded',current_stage:'uploaded',progress_percent:100,last_error:null,completed_at:null,started_at:null},'Batch returned to the upload queue.');
  }

  async function cancelBatch(batch){
    if(!confirm('Cancel processing for "'+sourceName(batch)+'"?'))return;
    await updateBatch(batch.id,{status:'cancelled',current_stage:'cancelled',last_error:'Cancelled by a staff member.'},'Import batch cancelled.');
  }

  async function deleteBatch(batch){
    if(!confirm('Delete "'+sourceName(batch)+'" and its stored source file? This cannot be undone.'))return;
    const client=getClient();
    if(batch.storage_bucket&&batch.storage_path){
      const {error:storageError}=await client.storage.from(batch.storage_bucket).remove([batch.storage_path]);
      if(storageError&&storageError.statusCode!==404)throw storageError;
    }
    const {error}=await client.from('import_batches').delete().eq('id',batch.id);
    if(error)throw error;
    state.batches=state.batches.filter(item=>item.id!==batch.id);
    if(state.selectedId===batch.id)closeDetails();
    renderAll();
    notify('Import batch deleted.','success');
  }

  function countsText(counts){
    if(!counts||typeof counts!=='object'||!Object.keys(counts).length)return 'No records yet';
    return Object.entries(counts).map(([key,value])=>String(key).replace(/_/g,' ')+': '+value).join(' · ');
  }

  function updatePipeline(batch){
    const stage=activeStage(batch);
    let current=STAGES.indexOf(stage);
    if(stage==='complete')current=STAGES.length;
    document.querySelectorAll('#import-pipeline [data-stage]').forEach((item,index)=>{
      item.classList.toggle('done',index<current);
      item.classList.toggle('active',index===current);
    });
  }

  function renderDetails(batch){
    state.selectedId=batch.id;
    byId('import-detail-title').textContent=sourceName(batch);
    const status=byId('import-detail-status');
    status.textContent=statusLabel(batch);
    status.className='import-status-pill '+statusClass(batch);
    const progress=progressOf(batch);
    byId('import-detail-progress').textContent=progress+'%';
    byId('import-detail-progress-bar').style.width=progress+'%';
    byId('import-detail-scope').textContent=SCOPE_LABELS[batch.entity_scope]||batch.entity_scope||'Inventory';
    byId('import-detail-size').textContent=formatBytes(batch.file_size);
    byId('import-detail-created').textContent=formatDate(batch.created_at);
    byId('import-detail-updated').textContent=formatDate(batch.updated_at||batch.created_at);
    byId('import-detail-stage').textContent=statusLabel(batch);
    byId('import-detail-counts').textContent=countsText(batch.record_counts);
    byId('import-detail-path').textContent=batch.storage_path?(batch.storage_bucket||BUCKET)+' / '+batch.storage_path:'Not stored yet.';
    byId('import-detail-notes').textContent=batch.notes||'No notes.';
    const errorSection=byId('import-detail-error-section');
    errorSection.hidden=!batch.last_error;
    byId('import-detail-error').textContent=batch.last_error||'';
    byId('import-detail-view-source').disabled=!(batch.storage_bucket&&batch.storage_path);
    byId('import-detail-retry').hidden=!(batch.status==='failed'||batch.status==='cancelled');
    byId('import-detail-cancel').hidden=TERMINAL.has(batch.status)||batch.status==='ready';
    byId('import-detail-drawer').hidden=false;
    byId('import-detail-backdrop').hidden=false;
    updatePipeline(batch);
    if(window.lucide)window.lucide.createIcons();
  }

  function closeDetails(){
    state.selectedId=null;
    byId('import-detail-drawer').hidden=true;
    byId('import-detail-backdrop').hidden=true;
    updatePipeline({status:'uploaded',current_stage:'uploaded'});
  }

  async function viewSource(batch){
    if(!(batch.storage_bucket&&batch.storage_path))return;
    const {data,error}=await getClient().storage.from(batch.storage_bucket).createSignedUrl(batch.storage_path,120);
    if(error)throw error;
    window.open(data.signedUrl,'_blank','noopener,noreferrer');
  }

  async function handleAction(action,id){
    const batch=state.batches.find(item=>item.id===id);
    if(!batch)return;
    try{
      if(action==='open')renderDetails(batch);
      else if(action==='retry')await retryBatch(batch);
      else if(action==='cancel')await cancelBatch(batch);
      else if(action==='delete')await deleteBatch(batch);
    }catch(error){console.error(error);notify(error.message||'The action failed.','error');}
  }

  function bind(){
    const drop=byId('import-queue-drop');
    const input=byId('import-queue-file-input');
    if(!drop||!input)return;
    const choose=()=>input.click();
    byId('import-queue-upload-button').addEventListener('click',choose);
    byId('import-queue-browse').addEventListener('click',event=>{event.stopPropagation();choose();});
    drop.addEventListener('click',event=>{if(!event.target.closest('button'))choose();});
    drop.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();choose();}});
    ['dragenter','dragover'].forEach(type=>drop.addEventListener(type,event=>{event.preventDefault();drop.classList.add('dragging');}));
    ['dragleave','drop'].forEach(type=>drop.addEventListener(type,event=>{event.preventDefault();drop.classList.remove('dragging');}));
    drop.addEventListener('drop',event=>handleFiles(event.dataTransfer.files));
    input.addEventListener('change',()=>handleFiles(input.files));
    byId('import-queue-refresh').addEventListener('click',()=>loadQueue(true));
    byId('import-queue-search').addEventListener('input',event=>{state.query=event.target.value;renderQueue();});
    byId('import-queue-filter').addEventListener('change',event=>{state.filter=event.target.value;renderQueue();});
    byId('import-queue-rows').addEventListener('click',event=>{const button=event.target.closest('[data-import-action]');if(button)handleAction(button.dataset.importAction,button.dataset.batchId);});
    byId('import-detail-close').addEventListener('click',closeDetails);
    byId('import-detail-backdrop').addEventListener('click',closeDetails);
    byId('import-detail-view-source').addEventListener('click',async()=>{const batch=state.batches.find(item=>item.id===state.selectedId);if(batch)try{await viewSource(batch);}catch(error){notify(error.message,'error');}});
    byId('import-detail-retry').addEventListener('click',async()=>{const batch=state.batches.find(item=>item.id===state.selectedId);if(batch)try{await retryBatch(batch);}catch(error){notify(error.message,'error');}});
    byId('import-detail-cancel').addEventListener('click',async()=>{const batch=state.batches.find(item=>item.id===state.selectedId);if(batch)try{await cancelBatch(batch);}catch(error){notify(error.message,'error');}});
    byId('import-detail-delete').addEventListener('click',async()=>{const batch=state.batches.find(item=>item.id===state.selectedId);if(batch)try{await deleteBatch(batch);}catch(error){notify(error.message,'error');}});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!byId('import-detail-drawer').hidden)closeDetails();});
    updatePipeline({status:'uploaded',current_stage:'uploaded'});
  }

  function render(){
    loadQueue(true);
    clearInterval(state.pollTimer);
    state.pollTimer=setInterval(()=>{
      const view=byId('imports-view');
      if(view&&view.style.display!=='none')loadQueue(false);
    },20000);
  }

  window.AtlasImportCenter={render,refresh:()=>loadQueue(true),closeDetails};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);else bind();
})();
