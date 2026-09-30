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

  function render() {
    const types = ['all', ...new Set(allItems.map(i => i.type))];
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
        <span class="price">${i.menu_price != null ? Math.round(i.menu_price).toLocaleString() + ' ISK' : ''}</span>
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
    allItems = data || [];
    render();
  })();
