// Public menu (menu.html). External since S96 so the CSP needs no 'unsafe-inline'.
  const cfg = window.VABAR_CONFIG;
  // The public menu always uses a fresh anonymous client. It never restores the
  // signed-in Alcedo session from shared browser storage.
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
  let allItems = [];
  let activeType = 'all';

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
  }

  // Recipe types come from the database (any manager can set them), so they
  // are data: escaped in markup, never trusted as HTML (S96 webstore).
  function typeLabel(t) {
    const text = String(t ?? '');
    return text ? text[0].toUpperCase() + text.slice(1) : '';
  }

  // Prices are '3.900 ISK' on every phone: '.' groups thousands, as in the
  // app's formatKr, whatever the guest's device language (audit L33).
  function price(value) {
    const amount = Math.round(Number(value));
    if (value === null || value === undefined || value === '' || !Number.isFinite(amount)) return '';
    return `${amount < 0 ? '-' : ''}${String(Math.abs(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} ISK`;
  }

  // The view has no order, so the menu sorts itself: Icelandic alphabetical
  // order on every device, then id, so the list never reshuffles (audit L33).
  const collator = new Intl.Collator('is', { sensitivity: 'base', numeric: true });
  function byName(a, b) {
    return collator.compare(String(a.name ?? ''), String(b.name ?? '')) || String(a.id ?? '').localeCompare(String(b.id ?? ''), 'en');
  }

  function render() {
    const types = ['all', ...[...new Set(allItems.map(i => i.type))].sort((a, b) => collator.compare(String(a ?? ''), String(b ?? '')))];
    document.getElementById('menu-tabs').innerHTML = types.map(t =>
      `<button class="tab ${t === activeType ? 'active' : ''}" data-type="${escapeHtml(t)}">${escapeHtml(t === 'all' ? 'All' : typeLabel(t))}</button>`
    ).join('');
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => { activeType = btn.dataset.type; render(); });
    });

    const visible = allItems.filter(i => activeType === 'all' || i.type === activeType);
    const list = document.getElementById('menu-list');
    if (visible.length === 0) {
      list.innerHTML = '<div class="empty">Menu coming soon.</div>';
      return;
    }
    list.innerHTML = visible.map(i => `
      <div class="menu-item">
        <span class="name">${escapeHtml(i.name)}</span>
        <span class="price">${price(i.menu_price)}</span>
      </div>
    `).join('');
  }

  (async function init() {
    const { data, error } = await sb
      .from('public_menu')
      .select('id,name,type,menu_price');
    if (error) {
      document.getElementById('menu-list').innerHTML = '<div class="empty">Menu unavailable right now.</div>';
      console.error(error);
      return;
    }
    allItems = (data || []).slice().sort(byName);
    render();
  })();
