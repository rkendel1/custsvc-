(function initGlobalAuthUi() {
  const chip = document.querySelector('[data-auth-state]');
  const signOutBtn = document.querySelector('[data-signout]');
  if (!chip && !signOutBtn) return;

  let passwordRequired = false;

  function setState(label, state) {
    if (!chip) return;
    chip.textContent = String(label || '');

    if (state === 'ok') {
      chip.style.background = '#e9f7ef';
      chip.style.color = '#1f6b3a';
      chip.style.borderColor = '#b8e4c8';
      return;
    }

    chip.style.background = '#fff3f3';
    chip.style.color = '#8f2e2e';
    chip.style.borderColor = '#f0d0d0';
  }

  async function refreshStatus() {
    try {
      const response = await fetch('/api/access/status');
      const data = await response.json();
      passwordRequired = Boolean(data.password_required);

      if (!passwordRequired) {
        setState('Access: open', 'ok');
        return;
      }

      if (data.authenticated) {
        setState('Access: signed in', 'ok');
      } else {
        setState('Access: signed out', 'bad');
      }
    } catch (_error) {
      setState('Access status unavailable', 'bad');
    }
  }

  if (signOutBtn) {
    signOutBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/access/logout', { method: 'POST' });
        setState('Access: signed out', 'bad');
        if (passwordRequired) {
          const next = String(signOutBtn.dataset.next || window.location.pathname || '/');
          window.location.href = `/access.html?next=${encodeURIComponent(next)}`;
        }
      } catch (_error) {
        setState('Sign out failed', 'bad');
      }
    });
  }

  refreshStatus();
})();
