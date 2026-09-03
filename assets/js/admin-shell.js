/**
 * assets/js/admin-shell.js — QLess V2 Tenant Admin Shell
 *
 * Responsibilities: layout, branding render, DB-driven navigation, module
 * lazy-loading + keep-alive, performance instrumentation, logout.
 *
 * Explicitly NOT this file's job: authentication, tenant resolution, role
 * resolution, permission resolution, or authorization of any kind. All of
 * that lives in config/auth.js + config/adminContext.js + RLS. This file
 * only renders what AdminContext gives it and hides UI the user shouldn't
 * see — it never decides who is allowed to see what at the data layer.
 */

import { loadAdminContext, signOutUser } from '../../config/adminContext.js';

performance.mark('shell_boot_start');

const state = {
  context: null,
  currentSection: 'overview', // 'overview' | 'module_<key>'
  mountedModules: new Set(), // keys whose iframe has been created at least once
};

const els = {
  loadingScreen: document.getElementById('loadingScreen'),
  sidebarNav: document.getElementById('sidebarNav'),
  brandName: document.getElementById('brandName'),
  brandLogo: document.getElementById('brandLogo'),
  brandLogoFallback: document.getElementById('brandLogoFallback'),
  sectionTitle: document.getElementById('sectionTitle'),
  overviewPanel: document.getElementById('overviewPanel'),
  moduleFrames: document.getElementById('moduleFrames'),
  userEmail: document.getElementById('userEmail'),
  userRole: document.getElementById('userRole'),
  logoutBtn: document.getElementById('logoutBtn'),
  perfLog: document.getElementById('perfLog'),
};

async function boot() {
  performance.mark('context_resolve_start');
  const context = await loadAdminContext(['tenant_owner']);
  performance.mark('context_resolve_end');

  if (!context) return; // requireAuth already redirected — nothing further to do

  performance.measure('context_resolve', 'context_resolve_start', 'context_resolve_end');
  state.context = context;

  renderBranding(context);
  renderIdentity(context);
  renderNav(context);
  renderOverview(context);
  wireLogout();

  performance.mark('shell_boot_end');
  performance.measure('shell_boot_total', 'shell_boot_start', 'shell_boot_end');
  logPerf();

  hideLoadingScreen();
}

/* ---------------- Branding ---------------- */

function renderBranding(context) {
  const b = context.branding;
  const root = document.documentElement;

  root.style.setProperty('--accent', (b && b.primaryColor) || '#6366f1');
  root.style.setProperty('--accent-2', (b && b.secondaryColor) || '#4f46e5');

  document.title = `${(b && b.name) || (context.activeTenant && context.activeTenant.name) || 'QLess'} · Admin`;
  els.brandName.textContent = (b && b.name) || (context.activeTenant && context.activeTenant.name) || 'QLess Admin';

  if (b && b.logoUrl) {
    els.brandLogo.src = b.logoUrl;
    els.brandLogo.style.display = '';
    els.brandLogoFallback.style.display = 'none';
    els.brandLogo.addEventListener('error', () => {
      els.brandLogo.style.display = 'none';
      els.brandLogoFallback.style.display = '';
    });
  } else {
    els.brandLogo.style.display = 'none';
    els.brandLogoFallback.style.display = '';
  }
}

function renderIdentity(context) {
  els.userEmail.textContent = context.user.email;
  els.userRole.textContent = (context.role && context.role.name) || '—';
}

/* ---------------- Navigation (100% DB-driven) ---------------- */

function renderNav(context) {
  els.sidebarNav.innerHTML = '';

  els.sidebarNav.appendChild(
    navItem({ key: 'overview', name: 'Overview', icon: 'fa-solid fa-gauge' }, true)
  );

  // enabledModules comes straight from tenant_modules JOIN modules for THIS
  // tenant. No hardcoded module list exists anywhere in this file.
  for (const mod of context.enabledModules) {
    els.sidebarNav.appendChild(navItem(mod, false));
  }

  if (context.enabledModules.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'nav-empty';
    empty.textContent = 'No modules enabled for this tenant yet.';
    els.sidebarNav.appendChild(empty);
  }
}

function navItem(mod, isOverview) {
  const sectionKey = isOverview ? 'overview' : `module_${mod.key}`;
  const btn = document.createElement('button');
  btn.className = 'nav-item';
  btn.dataset.section = sectionKey;
  btn.innerHTML = `<i class="${mod.icon || 'fa-solid fa-square'}"></i><span>${escapeHtml(mod.name)}</span>`;
  btn.addEventListener('click', () => selectSection(sectionKey, mod, isOverview));
  return btn;
}

function selectSection(sectionKey, mod, isOverview) {
  state.currentSection = sectionKey;

  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.section === sectionKey);
  });

  els.overviewPanel.style.display = isOverview ? '' : 'none';
  els.sectionTitle.textContent = isOverview ? 'Overview' : mod.name;

  document.querySelectorAll('.module-frame-wrap').forEach((el) => {
    el.style.display = el.dataset.section === sectionKey ? '' : 'none';
  });

  if (!isOverview) ensureModuleMounted(mod);
}

/* ---------------- Lazy iframe modules with keep-alive ----------------
   First click on a module: create + mount its iframe (Step 11, lazy load).
   Every subsequent click: just toggle visibility, never recreate the
   iframe or reload it (Step 12, keep-alive) — the module keeps its own
   in-page state (scroll position, open forms, etc.) between visits.
   Same-origin iframe ⇒ it shares the parent's Supabase session in
   localStorage automatically; no auth handoff needed here.
------------------------------------------------------------------------ */

function ensureModuleMounted(mod) {
  const sectionKey = `module_${mod.key}`;
  if (state.mountedModules.has(sectionKey)) return; // already mounted — keep-alive, do nothing

  performance.mark(`module_${mod.key}_load_start`);

  const wrap = document.createElement('div');
  wrap.className = 'module-frame-wrap';
  wrap.dataset.section = sectionKey;

  if (!mod.path) {
    wrap.innerHTML = `
      <div class="module-placeholder">
        <i class="fa-solid fa-hammer"></i>
        <p><strong>${escapeHtml(mod.name)}</strong> is enabled for this tenant but hasn't been built yet.</p>
      </div>`;
  } else {
    const iframe = document.createElement('iframe');
    iframe.className = 'module-iframe';
    iframe.src = mod.path;
    iframe.title = mod.name;
    iframe.addEventListener('load', () => {
      performance.mark(`module_${mod.key}_load_end`);
      performance.measure(`module_${mod.key}_load`, `module_${mod.key}_load_start`, `module_${mod.key}_load_end`);
      logPerf();
    });
    wrap.appendChild(iframe);
  }

  els.moduleFrames.appendChild(wrap);
  state.mountedModules.add(sectionKey);
}

/* ---------------- Overview panel ---------------- */

function renderOverview(context) {
  const tenant = context.activeTenant;
  els.overviewPanel.innerHTML = `
    <div class="overview-grid">
      <div class="stat-card">
        <div class="stat-label">Tenant</div>
        <div class="stat-value">${escapeHtml((tenant && tenant.name) || '—')}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Role</div>
        <div class="stat-value">${escapeHtml((context.role && context.role.name) || '—')}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Enabled modules</div>
        <div class="stat-value">${context.enabledModules.length}</div>
      </div>
    </div>
  `;
}

/* ---------------- Logout ---------------- */

function wireLogout() {
  els.logoutBtn.addEventListener('click', () => signOutUser());
}

/* ---------------- Perf instrumentation ---------------- */

function logPerf() {
  if (!els.perfLog) return;
  const entries = performance.getEntriesByType('measure').map((m) => `${m.name}: ${m.duration.toFixed(0)}ms`);
  els.perfLog.textContent = entries.join(' · ');
}

/* ---------------- Utilities ---------------- */

function hideLoadingScreen() {
  if (!els.loadingScreen) return;
  els.loadingScreen.classList.add('hidden');
  setTimeout(() => (els.loadingScreen.style.display = 'none'), 400);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

boot();
