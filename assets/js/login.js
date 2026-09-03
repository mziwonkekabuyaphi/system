/**
 * assets/js/login.js — QLess V2
 *
 * Drives login.html. Tenant context comes from the current hostname
 * (rands.co.za, venueb.co.za, ...) via config/auth.js — there is no venue
 * picker here and this file never sends a tenant_id anywhere.
 */
import {
  signIn,
  signInWithGoogle,
  signInWithPasskey,
  isPasskeySupported,
  getCurrentSession,
  getMyContext,
  resolveRoleFromContext,
  redirectByRole,
} from '../../config/auth.js';

const emailInput   = document.getElementById('email');
const passwordStep = document.getElementById('passwordStep');
const passwordInput = document.getElementById('password');
const forgotRow    = document.getElementById('passwordStepForgotRow');
const loginBtn     = document.getElementById('loginBtn');
const loginBtnLabel = document.getElementById('loginBtnLabel');
const authError    = document.getElementById('authError');
const errEmail     = document.getElementById('err-email');
const errPassword  = document.getElementById('err-password');
const togglePw     = document.getElementById('togglePw');
const eyeIcon      = document.getElementById('eyeIcon');
const eyeOffIcon   = document.getElementById('eyeOffIcon');
const googleBtn    = document.getElementById('googleBtn');
const passkeyWrap  = document.getElementById('passkeyWrap');
const passkeyBtn   = document.getElementById('passkeyBtn');
const loadingScreen = document.getElementById('loadingScreen');
const loadMsg      = document.getElementById('loadMsg');

let step = 'identifier'; // 'identifier' | 'password'

function looksLikeEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
function looksLikePhone(v) {
  return /^[0-9+][0-9\s-]{6,}$/.test(v);
}

function showError(el, message) {
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.style.display = 'block';
  } else {
    el.style.display = 'none';
  }
}

function clearAuthError() {
  if (authError) authError.textContent = '';
}

function hideLoadingScreen() {
  if (loadingScreen) loadingScreen.style.display = 'none';
}

/* =========================
   Redirect a fully authenticated user to the right place for THIS tenant
========================= */
async function finishLogin(user) {
  if (loadMsg) loadMsg.textContent = 'Loading your account…';
  if (loadingScreen) loadingScreen.style.display = 'flex';

  const { context, error } = await getMyContext();
  if (error) {
    hideLoadingScreen();
    showError(authError, 'Something went wrong loading your account. Please try again.');
    return;
  }

  if (!context || !context.tenant_id) {
    hideLoadingScreen();
    showError(authError, 'This site is not recognized as a QLess venue.');
    return;
  }

  const role = resolveRoleFromContext(context);
  if (!role) {
    // Authenticated, but no staff/admin/customer relationship to THIS venue yet.
    window.location.href = '/register.html';
    return;
  }

  redirectByRole(role);
}
window.finishLogin = finishLogin;

/* =========================
   Auto-continue if already signed in
========================= */
(async function checkExistingSession() {
  const { session } = await getCurrentSession();
  if (session?.user) {
    await finishLogin(session.user);
  } else {
    hideLoadingScreen();
  }
})();

/* =========================
   Step 1 → Step 2 (reveal password field)
========================= */
loginBtn?.addEventListener('click', async () => {
  clearAuthError();

  if (step === 'identifier') {
    const value = (emailInput?.value || '').trim();
    if (!looksLikeEmail(value) && !looksLikePhone(value)) {
      showError(errEmail, 'Enter a valid WhatsApp Number or Email address');
      return;
    }
    showError(errEmail, null);

    passwordStep.style.display = 'block';
    forgotRow.style.display = 'block';
    loginBtnLabel.textContent = 'Sign In';
    step = 'password';
    passwordInput?.focus();
    return;
  }

  // step === 'password'
  const identifier = (emailInput?.value || '').trim();
  const password = passwordInput?.value || '';
  if (!password) {
    showError(errPassword, 'Passport Key is required');
    return;
  }
  showError(errPassword, null);

  loginBtn.disabled = true;
  const originalLabel = loginBtnLabel.textContent;
  loginBtnLabel.textContent = 'Signing In...';

  try {
    // Phone-based sign-in requires Supabase's phone auth provider, which
    // Phase 1 hasn't configured yet — only email/password works today.
    if (!looksLikeEmail(identifier)) {
      showError(authError, 'Phone sign-in isn\u2019t available yet — please sign in with your email for now.');
      return;
    }

    const { user, error } = await signIn(identifier, password);
    if (error) {
      showError(authError, error);
      return;
    }
    await finishLogin(user);
  } finally {
    loginBtn.disabled = false;
    loginBtnLabel.textContent = originalLabel;
  }
});

/* =========================
   Show/hide password
========================= */
togglePw?.addEventListener('click', () => {
  const isHidden = passwordInput.type === 'password';
  passwordInput.type = isHidden ? 'text' : 'password';
  if (eyeIcon) eyeIcon.style.display = isHidden ? 'none' : 'block';
  if (eyeOffIcon) eyeOffIcon.style.display = isHidden ? 'block' : 'none';
});

/* =========================
   Google OAuth — redirects away; finishLogin() runs from login.html's
   own onAuthStateChange handler when the browser comes back with a session.
========================= */
googleBtn?.addEventListener('click', async () => {
  clearAuthError();
  const { error } = await signInWithGoogle();
  if (error) showError(authError, error);
});

/* =========================
   Passkey
========================= */
(async function setupPasskey() {
  if (await isPasskeySupported()) {
    passkeyWrap.style.display = 'block';
  }
})();

passkeyBtn?.addEventListener('click', async () => {
  clearAuthError();
  const { user, error } = await signInWithPasskey();
  if (error) {
    showError(authError, error);
    return;
  }
  await finishLogin(user);
});
