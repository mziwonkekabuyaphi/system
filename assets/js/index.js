//
// QLESS V2 — PUBLIC SPLASH / GATEWAY PAGE
// Features:
// - Tenant resolution from hostname via the existing get_tenant_by_domain RPC
// - Auto-redirect to login after ~5.2s (4s progress + 1.2s hold), gated on
//   a successfully resolved tenant
// - Tap anywhere to skip immediately (once tenant is resolved)
// - Install banner works on Android (with fallback for iOS/others)
// - iOS banner hidden automatically
//
// Scope: this file only resolves and displays tenant branding. It never
// performs authentication and never invents/hardcodes a fallback tenant.
//
import { supabase } from '../../config/supabase.js';


// --------------------
// Service Worker Registration
// --------------------
// Registers the new QLess V2 sw.js (root scope, cache 'qless-v2-static-v1').
// This is a fresh V2 file, not derived from the old Rands service worker.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then(reg => console.log('✅ Service Worker registered:', reg.scope))
      .catch(err => console.error('❌ Service Worker registration failed:', err));
  });
}

// --------------------
// Platform Detection
// --------------------
const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

// --------------------
// PWA Install Handling
// --------------------
let deferredPrompt = null;
const installBanner = document.getElementById('installBanner');
const installBtn = document.getElementById('installBtn');
const closeInstallBtn = document.getElementById('closeInstallBtn');

// 🔥 FIX: Hide the Chrome-style banner on iOS (it never works there)
if (isIos && installBanner) {
  installBanner.style.display = 'none';
}

function setInstallReady(ready) {
  if (!installBtn) return;
  installBtn.disabled = !ready;
  installBtn.style.opacity = ready ? '1' : '0.5';
  installBtn.style.cursor = ready ? 'pointer' : 'not-allowed';
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (!localStorage.getItem('installDismissed') && installBanner) {
    installBanner.style.display = 'flex';
    setInstallReady(true);
  }
  console.log('📲 Install prompt captured');
});

// 🔥 FIX: Install button now has a fallback if prompt is missing
installBtn?.addEventListener('click', async () => {
  if (deferredPrompt) {
    try {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      console.log('📲 Install outcome:', outcome);
    } catch (err) {
      console.error('❌ Install error:', err);
    } finally {
      deferredPrompt = null;
      setInstallReady(false);
      if (installBanner) installBanner.style.display = 'none';
      localStorage.setItem('installDismissed', 'true');
    }
  } else {
    // Fallback for iOS / unsupported browsers / already installed
    alert('To install this app, tap the Share icon and select "Add to Home Screen".');
  }
});

closeInstallBtn?.addEventListener('click', () => {
  if (installBanner) installBanner.style.display = 'none';
  localStorage.setItem('installDismissed', 'true');
});

window.addEventListener('appinstalled', () => {
  console.log('✅ App installed successfully');
  deferredPrompt = null;
  if (installBanner) installBanner.style.display = 'none';
});

// If already in standalone mode, hide the banner
if (
  window.matchMedia('(display-mode: standalone)').matches ||
  window.navigator.standalone === true
) {
  localStorage.setItem('installDismissed', 'true');
  if (installBanner) installBanner.style.display = 'none';
}

// --------------------
// Splash Elements
// --------------------
const splashRoot = document.getElementById('splashRoot');
const progressFill = document.getElementById('progressFill');
const statusElement = document.getElementById('statusMessage');
const percentageElement = document.getElementById('percentage');
const tenantHeading = document.getElementById('tenantHeading');
const tenantLogoImg = document.getElementById('tenantLogoImg');
const tenantLogoText = document.getElementById('tenantLogoText');
const themeColorMeta = document.getElementById('themeColorMeta');
const pageTitleEl = document.getElementById('pageTitle');
const stateUnavailable = document.getElementById('stateUnavailable');
const stateError = document.getElementById('stateError');

// Neutral QLess placeholder — same data URI baked into the HTML markup.
// Used as the fallback if a tenant has no logo_url, or if a logo_url fails to load.
const NEUTRAL_LOGO_DATA_URI =
  "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='48' fill='none' stroke='white' stroke-width='4'/%3E%3Ctext x='50' y='63' font-family='Segoe UI, sans-serif' font-size='42' font-weight='700' fill='white' text-anchor='middle'%3EQ%3C/text%3E%3C/svg%3E";

// --------------------
// Splash Messages
// --------------------
const messageStages = [
  { threshold: 0, text: "Welcome to QLess" },
  { threshold: 10, text: "Securing your session" },
  { threshold: 25, text: "Loading your wallet" },
  { threshold: 40, text: "Syncing balance and transactions" },
  { threshold: 55, text: "Preparing event access system" },
  { threshold: 70, text: "Loading your dashboard" },
  { threshold: 85, text: "Finalising secure connection" },
  { threshold: 95, text: "Entering QLess platform" }
];

function updateMessage(text) {
  if (!statusElement) return;
  statusElement.innerHTML = `<span>${text}</span><span class="pulse-dots"><span>.</span><span>.</span><span>.</span></span>`;
}

function updateStatus(progress) {
  const percent = Math.min(100, Math.floor(progress));
  if (percentageElement) percentageElement.textContent = `${percent}%`;
  if (progressFill) progressFill.style.width = `${percent}%`;
  let currentMessage = messageStages[0].text;
  for (let i = messageStages.length - 1; i >= 0; i--) {
    if (percent >= messageStages[i].threshold) {
      currentMessage = messageStages[i].text;
      break;
    }
  }
  updateMessage(currentMessage);
}

// --------------------
// Tenant Resolution
// --------------------
const TENANT_STATE = { PENDING: 'pending', READY: 'ready', UNAVAILABLE: 'unavailable', ERROR: 'error' };
let tenantState = TENANT_STATE.PENDING;
let redirectRequested = false; // set when the visitor taps or the auto-timer fires before resolution finishes

function hexToRgbTriplet(hex) {
  if (typeof hex !== 'string') return null;
  const match = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!match) return null;
  const int = parseInt(match[1], 16);
  return `${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}`;
}

function applyBranding(tenant) {
  const root = document.documentElement;

  if (tenant.primary_color) {
    root.style.setProperty('--qless-primary', tenant.primary_color);
    const rgb = hexToRgbTriplet(tenant.primary_color);
    if (rgb) root.style.setProperty('--qless-primary-rgb', rgb);
    if (themeColorMeta) themeColorMeta.setAttribute('content', tenant.primary_color);
  }

  if (tenant.secondary_color) {
    root.style.setProperty('--qless-secondary', tenant.secondary_color);
  }

  const name = tenant.display_name || tenant.tenant_name || 'QLess';

  if (tenantHeading) tenantHeading.textContent = `${name} Vibe Pass`;
  if (tenantLogoText) tenantLogoText.textContent = (tenant.tenant_slug || name).toUpperCase();
  if (pageTitleEl) pageTitleEl.textContent = `${name} · Vibe Pass`;
  document.title = `${name} · Vibe Pass`;

  if (tenant.logo_url && tenantLogoImg) {
    tenantLogoImg.src = tenant.logo_url;
    // If the stored logo URL fails to load, fall back to the neutral mark
    // rather than leaving a broken image.
    tenantLogoImg.onerror = () => {
      tenantLogoImg.onerror = null;
      tenantLogoImg.src = NEUTRAL_LOGO_DATA_URI;
    };
  }
  // If no logo_url, the markup's neutral placeholder is left as-is.
}

function showBlockingState(kind) {
  // Stop the splash animation/timers entirely — we are not proceeding to login.
  splashDismissed = true;
  if (animationRequestId) cancelAnimationFrame(animationRequestId);
  if (autoRedirectTimer) clearTimeout(autoRedirectTimer);

  if (splashRoot) splashRoot.style.display = 'none';
  if (installBanner) installBanner.style.display = 'none';

  if (kind === 'unavailable' && stateUnavailable) stateUnavailable.hidden = false;
  if (kind === 'error' && stateError) stateError.hidden = false;
}

async function resolveTenant() {
  try {
    const { data, error } = await supabase.rpc('get_tenant_by_domain', {
      p_domain: window.location.hostname
    });

    if (error) {
      // Never expose the raw Supabase error to the customer.
      console.error('❌ Tenant resolution RPC error:', error);
      tenantState = TENANT_STATE.ERROR;
      showBlockingState('error');
      return;
    }

    if (!data || data.length === 0) {
      // Unknown domain, disabled domain, or inactive/suspended tenant —
      // get_tenant_by_domain returns zero rows for all of these identically.
      // Never assume Rands or any other tenant here.
      console.warn('⚠️ No active tenant found for hostname:', window.location.hostname);
      tenantState = TENANT_STATE.UNAVAILABLE;
      showBlockingState('unavailable');
      return;
    }

    const tenant = data[0];
    applyBranding(tenant);
    tenantState = TENANT_STATE.READY;

    // If the visitor already tapped, or the auto-redirect timer already fired,
    // proceed to login now that we actually have a tenant.
    if (redirectRequested) {
      attemptRedirect();
    }
  } catch (err) {
    console.error('❌ Unexpected error resolving tenant:', err);
    tenantState = TENANT_STATE.ERROR;
    showBlockingState('error');
  }
}

// Kick off tenant resolution immediately, in parallel with the splash
// animation below — it must never block the visual splash.
resolveTenant();

document.getElementById('retryUnavailableBtn')?.addEventListener('click', () => window.location.reload());
document.getElementById('retryErrorBtn')?.addEventListener('click', () => window.location.reload());

// --------------------
// Redirect Logic (Auto + Tap-to-Skip), gated on tenant resolution
// --------------------
let splashDismissed = false;
let animationRequestId = null;
let autoRedirectTimer = null;

function attemptRedirect() {
  if (splashDismissed) return;

  if (tenantState === TENANT_STATE.READY) {
    splashDismissed = true;
    if (animationRequestId) cancelAnimationFrame(animationRequestId);
    if (autoRedirectTimer) clearTimeout(autoRedirectTimer);
    // Plain navigation to login.html — no tenant_id/tenant_slug appended.
    // login.html performs its own hostname-based tenant resolution.
    window.location.href = 'login.html';
    return;
  }

  if (tenantState === TENANT_STATE.PENDING) {
    // Not resolved yet — navigate the instant it succeeds.
    redirectRequested = true;
    return;
  }

  // ERROR / UNAVAILABLE: the blocking state screen is already shown; ignore.
}

// Tap/click anywhere to skip the wait
document.body.addEventListener('click', attemptRedirect);
document.body.addEventListener('touchstart', attemptRedirect);

// Auto-redirect trigger after progress hits 100%
function startAutoRedirect() {
  // Wait 1.2 seconds after hitting 100% before attempting redirect
  autoRedirectTimer = setTimeout(() => {
    attemptRedirect();
  }, 1200);
}

// --------------------
// Visual Progress Animation
// --------------------
let startTime = null;

function animate(timestamp) {
  if (!startTime) startTime = timestamp;
  const elapsed = timestamp - startTime;
  const progress = Math.min(100, (elapsed / 4000) * 100); // 4 second cycle

  updateStatus(progress);

  if (progress < 100 && !splashDismissed) {
    // Keep animating
    animationRequestId = requestAnimationFrame(animate);
  } else if (progress >= 100 && !splashDismissed) {
    // Hit 100% – update message and start the auto-redirect countdown
    updateStatus(100);
    updateMessage("Tap anywhere or wait...");
    startAutoRedirect();
  }
}

// Kick off the animation
animationRequestId = requestAnimationFrame(animate);

// --------------------
// Offline / Online Detection
// --------------------
window.addEventListener('offline', () => updateMessage("📡 You're offline"));
window.addEventListener('online', () => updateMessage("✅ Connection restored"));
