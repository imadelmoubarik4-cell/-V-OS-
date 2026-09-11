(function () {
  'use strict';
  const trigger = document.getElementById('purchase-orders-tab');
  const deliveriesTrigger = document.getElementById('purchase-deliveries-tab');
  const panel = document.getElementById('purchase-order-panel');
  if (!trigger || !deliveriesTrigger || !panel) return;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  let orders = [], draft = null, busy = false, activeSection = 'orders';
  const choices = () => window.atlasPurchasingData?.() || { items: [], suppliers: [] };
  const status = message => { panel.querySelector('[data-order-status]').textContent = message; };
  const resetDraft = () => { draft = { id: crypto.randomUUID(), version: null, supplier_id: '', lines: [], note: '' }; };
  function lineMarkup(line = {}) {
    return `<div data-order-line style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:8px;margin:8px 0">
      <label>Item<select data-item required>${choices().items.filter(x => x.active !== false).map(x=>`<option value="${esc(x.id)}" ${x.id===line.item_id?'selected':''}>${esc(x.name)} (${esc(x.unit)})</option>`).join('')}</select></label>
      <label>Quantity<input data-quantity type="number" min="0.000001" max="1000000" step="any" value="${esc(line.quantity ?? 1)}" required></label>
      <label>Unit cost (ISK)<input data-cost type="number" min="0" max="100000000" step="any" value="${esc(line.unit_cost ?? 0)}" required></label>
      <button type="button" data-remove-line aria-label="Remove order line">×</button></div>`;
  }
  function render() {
    if (!draft) resetDraft();
    const suppliers = choices().suppliers;
    const visibleOrders = activeSection === 'deliveries'
      ? orders.filter(order => ['ordered', 'received'].includes(order.status))
      : orders;
    const editor = activeSection === 'orders' ? `<form id="purchase-order-form"><h3>${draft.version ? 'Amend draft' : 'New order'}</h3>
      <label>Supplier<select name="supplier" required><option value="">Choose supplier</option>${suppliers.filter(x=>x.active!==false).map(x=>`<option value="${esc(x.id)}" ${x.id===draft.supplier_id?'selected':''}>${esc(x.name)}</option>`).join('')}</select></label>
      <div data-order-lines>${(draft.lines.length ? draft.lines : [{}]).map(lineMarkup).join('')}</div>
      <button type="button" data-add-line>Add item</button><label>Note<textarea name="note" maxlength="2000">${esc(draft.note)}</textarea></label>
      <button type="submit">Save draft</button><button type="button" data-new-order>Clear form</button></form>` : '';
    panel.innerHTML = `<h2>${activeSection === 'orders' ? 'Purchase orders' : 'Deliveries'}</h2><p>${activeSection === 'orders' ? 'Quantities use the inventory unit shown beside each item.' : 'Receive ordered deliveries only after every delivered line has been checked. Receiving records stock and restock movements.'}</p>
      <p role="status" data-order-status></p><button type="button" data-refresh-orders>Refresh orders</button>
      ${editor}<div data-order-list>${visibleOrders.map(order=>`<article class="purchase-order-card"><h3>${esc(suppliers.find(x=>x.id===order.supplier_id)?.name || 'Supplier')} · ${esc(order.status)}</h3>
      <p>Order ${esc(order.id)} · version ${order.version}</p><ul>${order.lines.map(line=>`<li>${esc(line.item_name)}: ${esc(line.quantity)} ${esc(line.unit)} × ${esc(line.unit_cost)} ISK</li>`).join('')}</ul><p>${esc(order.note)}</p>
      ${order.status==='draft'?`<button type="button" data-command="edit" data-order="${order.id}">Amend</button> <button type="button" data-command="place" data-order="${order.id}">Mark ordered</button>`:''}
      ${order.status==='ordered'?`<button type="button" data-command="receive" data-order="${order.id}">Receive all items</button>`:''}
      ${['draft','ordered'].includes(order.status)?`<button type="button" data-command="cancel" data-order="${order.id}">Cancel order</button>`:''}</article>`).join('') || `<p>No ${activeSection === 'orders' ? 'orders' : 'deliveries'} recorded.</p>`}</div>`;
  }
  async function refresh() {
    if (!navigator.onLine) { status('Offline. Saved orders cannot be refreshed until you reconnect.'); return; }
    try {
      const { data, error } = await window.atlasSupabase.from('purchase_orders').select('*').order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      orders = data || []; render();
    } catch (_) { status('Orders could not be loaded. Check your connection or ask an administrator to check this environment.'); }
  }
  async function command(args) {
    if (busy || !window.atlasCanManageCommercial?.()) return;
    if (!navigator.onLine) { status('Offline: nothing was submitted. Reconnect and refresh first.'); return; }
    busy = true;
    panel.querySelectorAll('button').forEach(button=>button.disabled=true);
    try {
      const { error } = await window.atlasSupabase.rpc('atlas_purchase_order_command', args);
      if (error) throw error;
      if (['create','update'].includes(args.p_action)) resetDraft();
      await window.atlasReloadPurchasingData();
      await refresh(); status('Order saved.');
    } catch (error) {
      status((error.message || 'Order could not be saved.') + ' Refresh to check its state before retrying.');
    } finally { busy = false; panel.querySelectorAll('button').forEach(button=>button.disabled=false); }
  }
  trigger.disabled = false; trigger.title = 'Create and receive purchase orders';
  deliveriesTrigger.disabled = false;
  const openSection = async (section) => {
    if (!window.atlasCanManageCommercial?.()) return;
    activeSection = section;
    panel.hidden = false;
    trigger.classList.toggle('active', section === 'orders');
    deliveriesTrigger.classList.toggle('active', section === 'deliveries');
    render();
    await refresh();
  };
  trigger.addEventListener('click', () => openSection('orders'));
  deliveriesTrigger.addEventListener('click', () => openSection('deliveries'));
  panel.addEventListener('click', async event => {
    if (busy) return;
    const button = event.target.closest('button'); if (!button) return;
    if (button.hasAttribute('data-add-line')) {
      if (panel.querySelectorAll('[data-order-line]').length < 100) panel.querySelector('[data-order-lines]').insertAdjacentHTML('beforeend',lineMarkup());
    } else if (button.hasAttribute('data-remove-line')) button.closest('[data-order-line]').remove();
    else if (button.hasAttribute('data-new-order')) { resetDraft(); render(); }
    else if (button.hasAttribute('data-refresh-orders')) await refresh();
    else if (button.dataset.command) {
      const order = orders.find(x=>x.id===button.dataset.order); if (!order) return;
      if (button.dataset.command==='edit') { draft=structuredClone(order); render(); return; }
      if (button.dataset.command==='receive' && !confirm('Receive every line in this order? This records stock and restock movements.')) return;
      await command({p_id:order.id,p_action:button.dataset.command,p_version:order.version});
    }
  });
  panel.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    draft.supplier_id = form.elements.supplier.value; draft.note = form.elements.note.value;
    draft.lines = [...form.querySelectorAll('[data-order-line]')].map(row=>({item_id:row.querySelector('[data-item]').value,quantity:Number(row.querySelector('[data-quantity]').value),unit_cost:Number(row.querySelector('[data-cost]').value)}));
    if (!draft.lines.length) { status('Add at least one item.'); return; }
    await command({p_id:draft.id,p_action:draft.version?'update':'create',p_version:draft.version,p_supplier_id:draft.supplier_id,p_lines:draft.lines,p_note:draft.note});
  });
  window.addEventListener('atlas:profile-ready', () => { orders=[]; draft=null; panel.hidden=true; panel.replaceChildren(); });
})();
