/**
 * assets/js/dashboard.js — QLess V2 Tenant Admin Dashboard
 *
 * This is the Rands-styled dashboard.html's shell logic, reimplemented
 * against the shared multi-tenant AdminContext instead of the old inline
 * Vue app + direct/hardcoded Supabase calls. It renders into the SAME
 * markup/classes the page already has, so the visual design (collapsible
 * hover sidebar, loading sequence, topbar crumb, card styling, etc.) is
 * unchanged — only where the data/auth comes from has changed.
 *
 * Explicitly NOT this file's job: authentication, tenant resolution, role
 * resolution, or permission resolution. All of that lives in
 * config/auth.js + config/adminContext.js + RLS, exactly like the new
 * admin-shell.js. This file only renders what AdminContext gives it.
 *
 * Functional parity target: the new multi-tenant shell (admin-shell.js +
 * dashboard (1).html) — which has no Settings page — not the old
 * single-tenant Vue dashboard. The old Settings tab (Venue Info / Theme /
 * System Prefs / Module Visibility) has been intentionally dropped rather
 * than ported, per instruction.
 */

import { loadAdminContext, signOutUser } from '../../config/adminContext.js';

const DEFAULT_RED = '#E30613';

const state = {
  context: null,
  currentSection: 'overview', // 'overview' | 'module_<key>'
  mountedModules: new Set(), // sectionKeys whose frame wrap has been created at least once
};

const els = {
  loadingScreen: document.getElementById('loadingScreen'),
  loadLogoImg: document.getElementById('loadLogoImg'),
  loadLogoFallback: document.getElementById('loadLogoFallback'),
  loadBrand: document.getElementById('loadBrand'),
  loadMsg: document.getElementById('loadMsg'),

  sidebarBackdrop: document.getElementById('sidebarBackdrop'),
  sidebar: document.getElementById('sidebar'),
  brandLogo: document.getElementById('brandLogo'),
  brandLogoFallback: document.getElementById('brandLogoFallback'),
  brandName: document.getElementById('brandName'),
  sbNav: document.getElementById('sbNav'),
  sidebarLogout: document.getElementById('sidebarLogout'),

  main: document.getElementById('main'),
  menuToggle: document.getElementById('menuToggle'),
  topbarTitle: document.getElementById('topbarTitle'),
  refreshBtn: document.getElementById('refreshBtn'),
  topbarLogout: document.getElementById('topbarLogout'),

  content: document.getElementById('content'),
  overviewPanel: document.getElementById('overviewPanel'),
  moduleFrames: document.getElementById('moduleFrames'),
};

async function boot() {
  setLoadMsg('Loading your account…');
  const context = await loadAdminContext(['tenant_owner']);
  if (!context) return; // requireAuth already redirected — nothing further to do
  state.context = context;

  applyBranding(context);
  renderNav(context);
  renderOverview(context);
  wireStaticUI();

  setLoadMsg('Booting dashboard…');

  // Deep-link support: ?module=<module key> opens straight into that
  // module's iframe instead of always landing on Overview. Mirrors the
  // old dashboard's behaviour for pages (e.g. Event Monitor) that send
  // people back into this shell rather than opening a module unframed.
  const requestedKey = new URLSearchParams(window.location.search).get('module');
  const requestedModule = requestedKey
    ? context.enabledModules.find((m) => m.key === requestedKey)
    : null;

  if (requestedModule) {
    selectSection('module_' + requestedModule.key, requestedModule, false);
  } else {
    selectSection('overview', null, true);
  }

  setTimeout(hideLoadingScreen, 500);
}

/* ---------------- Branding (venue-configured colors) ---------------- */

function applyBranding(context) {
  const b = context.branding;
  const tenantName = (b && b.name) || (context.activeTenant && context.activeTenant.name) || 'QLess';
  const red = (b && b.primaryColor) || DEFAULT_RED;

  const root = document.documentElement;
  root.style.setProperty('--red', red);
  root.style.setProperty('--red-glow', hexToRgba(red, 0.35));
  root.style.setProperty('--red-dim', hexToRgba(red, 0.12));
  root.style.setProperty('--red-border', hexToRgba(red, 0.25));

  document.title = `${tenantName} · Command Centre`;
  els.brandName.textContent = tenantName;
  els.loadBrand.textContent = tenantName;

  const logoUrl = b && b.logoUrl;
  if (logoUrl) {
    for (const [img, fallback] of [
      [els.brandLogo, els.brandLogoFallback],
      [els.loadLogoImg, els.loadLogoFallback],
    ]) {
      img.src = logoUrl;
      img.alt = tenantName;
      img.style.display = '';
      fallback.style.display = 'none';
      img.addEventListener('error', () => {
        img.style.display = 'none';
        fallback.style.display = '';
      });
    }
  }
}

function hexToRgba(hex, alpha) {
  const clean = (hex || '').replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = parseInt(full, 16);
  if (Number.isNaN(num) || full.length !== 6) return `rgba(227, 6, 19, ${alpha})`; // DEFAULT_RED fallback
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const bl = num & 255;
  return `rgba(${r}, ${g}, ${bl}, ${alpha})`;
}

/* ---------------- Navigation (100% DB-driven, tenant-scoped) ---------------- */

function renderNav(context) {
  els.sbNav.innerHTML = '';

  // Control Centre — one item per enabled module for THIS tenant
  els.sbNav.appendChild(sectionLabel('Control Centre'));

  if (context.enabledModules.length) {
    for (const mod of context.enabledModules) {
      els.sbNav.appendChild(
        navItem({
          sectionKey: 'module_' + mod.key,
          icon: mod.icon || 'fas fa-square',
          label: mod.name,
          onClick: () => selectSection('module_' + mod.key, mod, false),
        })
      );
    }
  } else {
    els.sbNav.appendChild(navMessage('fas fa-circle-info', 'No active modules', 'var(--text-dim)'));
  }

  els.sbNav.appendChild(divider());

  // Analytics — Overview
  const tenantName = (context.branding && context.branding.name) ||
    (context.activeTenant && context.activeTenant.name) || 'QLess';
  els.sbNav.appendChild(sectionLabel('Analytics'));
  els.sbNav.appendChild(
    navItem({
      sectionKey: 'overview',
      icon: 'fas fa-chart-pie',
      label: `${tenantName} Overview`,
      onClick: () => selectSection('overview', null, true),
    })
  );
}

function sectionLabel(text) {
  const el = document.createElement('div');
  el.className = 'sb-section-label';
  el.innerHTML = `<span class="sb-section-dot"></span><span class="sb-section-text">${escapeHtml(text)}</span>`;
  return el;
}

function divider() {
  const el = document.createElement('div');
  el.className = 'sb-divider';
  return el;
}

function navMessage(icon, label, color) {
  const el = document.createElement('div');
  el.className = 'sb-item';
  el.style.color = color;
  el.style.cursor = 'default';
  el.innerHTML = `<span class="sb-item-icon"><i class="${icon}"></i></span><span class="sb-item-label">${escapeHtml(label)}</span>`;
  return el;
}

function navItem({ sectionKey, icon, label, onClick }) {
  const el = document.createElement('div');
  el.className = 'sb-item';
  el.dataset.section = sectionKey;
  el.innerHTML = `<span class="sb-item-icon"><i class="${icon}"></i></span><span class="sb-item-label">${escapeHtml(label)}</span>`;
  el.addEventListener('click', () => {
    onClick();
    closeMobileSidebar();
  });
  return el;
}

function markActiveNav(sectionKey) {
  document.querySelectorAll('.sb-item[data-section]').forEach((el) => {
    el.classList.toggle('active', el.dataset.section === sectionKey);
  });
}

/* ---------------- Section switching ---------------- */

function selectSection(sectionKey, mod, isOverview) {
  state.currentSection = sectionKey;
  markActiveNav(sectionKey);

  els.topbarTitle.textContent = isOverview
    ? `${(state.context.branding && state.context.branding.name) || (state.context.activeTenant && state.context.activeTenant.name) || 'QLess'} Overview`
    : mod.name;

  els.overviewPanel.style.display = isOverview ? '' : 'none';
  document.querySelectorAll('.module-frame-wrap').forEach((el) => {
    el.style.display = el.dataset.section === sectionKey ? '' : 'none';
  });

  if (!isOverview) ensureModuleMounted(mod);
}

/* ---------------- Lazy iframe modules with keep-alive ----------------
   First visit to a module: create + mount its iframe. Every subsequent
   visit: just toggle visibility, never recreate or reload it — the module
   keeps its own in-page state (scroll position, open forms, etc.) between
   visits. Same-origin iframe ⇒ it shares the parent's Supabase session in
   localStorage automatically; no auth handoff needed here.
------------------------------------------------------------------------ */

function ensureModuleMounted(mod) {
  const sectionKey = 'module_' + mod.key;
  if (state.mountedModules.has(sectionKey)) return; // already mounted — keep-alive, do nothing

  const wrap = document.createElement('div');
  wrap.dataset.section = sectionKey;
  wrap.className = 'module-frame-wrap';
  wrap.style.position = 'absolute';
  wrap.style.inset = '0';

  if (!mod.path) {
    wrap.innerHTML = `
      <div class="frame-loading" style="position:static; height:100%; flex-direction:column; gap:10px;">
        <i class="fas fa-hammer"></i>
        <span>${escapeHtml(mod.name)} is enabled but hasn't been built yet.</span>
      </div>`;
  } else {
    const loading = document.createElement('div');
    loading.className = 'frame-loading';
    loading.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Loading module…`;

    const iframe = document.createElement('iframe');
    iframe.className = 'external-iframe';
    iframe.src = mod.path;
    iframe.title = mod.name;
    iframe.frameBorder = '0';
    iframe.addEventListener('load', () => loading.remove(), { once: true });

    wrap.appendChild(loading);
    wrap.appendChild(iframe);
  }

  els.moduleFrames.appendChild(wrap);
  state.mountedModules.add(sectionKey);
}

/* ---------------- Overview panel ---------------- */

function renderOverview(context) {
  const tenant = context.activeTenant;
  els.overviewPanel.innerHTML = `
    <div class="settings-scroll">
      <div class="settings-grid">
        <div class="settings-card">
          <div class="settings-card-header">
            <div class="settings-card-icon"><i class="fas fa-building"></i></div>
            <div class="settings-card-title">Tenant</div>
          </div>
          <div style="font-family:'Space Grotesk',sans-serif; font-size:1.3rem; font-weight:700;">${escapeHtml((tenant && tenant.name) || '—')}</div>
        </div>
        <div class="settings-card">
          <div class="settings-card-header">
            <div class="settings-card-icon"><i class="fas fa-user-shield"></i></div>
            <div class="settings-card-title">Role</div>
          </div>
          <div style="font-family:'Space Grotesk',sans-serif; font-size:1.3rem; font-weight:700;">${escapeHtml((context.role && context.role.name) || '—')}</div>
        </div>
        <div class="settings-card">
          <div class="settings-card-header">
            <div class="settings-card-icon"><i class="fas fa-toggle-on"></i></div>
            <div class="settings-card-title">Enabled Modules</div>
          </div>
          <div style="font-family:'Space Grotesk',sans-serif; font-size:1.3rem; font-weight:700;">${context.enabledModules.length}</div>
        </div>
      </div>
    </div>`;
}

/* ---------------- Static UI wiring (mobile menu, refresh, logout) ---------------- */

function wireStaticUI() {
  els.menuToggle.addEventListener('click', () => {
    const isOpen = els.sidebar.classList.toggle('open');
    els.sidebarBackdrop.style.display = isOpen ? 'block' : 'none';
  });
  els.sidebarBackdrop.addEventListener('click', closeMobileSidebar);

  els.refreshBtn.addEventListener('click', () => {
    document.querySelectorAll('.external-iframe').forEach((f) => {
      if (f.offsetParent !== null && f.src) f.src = f.src;
    });
  });

  els.sidebarLogout.addEventListener('click', () => signOutUser());
  els.topbarLogout.addEventListener('click', () => signOutUser());
}

function closeMobileSidebar() {
  if (window.innerWidth <= 768) {
    els.sidebar.classList.remove('open');
    els.sidebarBackdrop.style.display = 'none';
  }
}

/* ---------------- Utilities ---------------- */

function setLoadMsg(msg) {
  if (els.loadMsg) els.loadMsg.textContent = msg;
}

function hideLoadingScreen() {
  els.loadingScreen.style.display = 'none';
  els.sidebar.style.visibility = '';
  els.main.style.visibility = '';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

boot();
