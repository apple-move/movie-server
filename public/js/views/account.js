import { api } from '../api.js';
import { el, clear, toast } from '../dom.js';
import { icon } from '../icons.js';
import { state, syncUserUI } from '../app.js';

/**
 * Account page — the signed-in user's own settings:
 *   display name, password, two-factor authentication, active sessions.
 */
export async function renderAccount(root) {
  clear(root);

  const wrap = el('div', { class: 'admin' });
  const panel = el('div', { class: 'admin__grid' });
  wrap.append(panel);
  root.append(wrap);

  panel.append(
    el(
      'div',
      { class: 'panel' },
      el('h3', {}, 'Account'),
      el('p', { class: 'hint' }, `Signed in as ${state.user?.username} (${state.user?.role}).`),
      el(
        'div',
        { class: 'account-badges' },
        el('span', { class: 'pill' }, icon('user', { size: 12 }), state.user?.username),
        el('span', { class: 'pill pill--accent' }, state.user?.role),
        state.user?.totpEnabled
          ? el('span', { class: 'pill pill--ok' }, icon('shield', { size: 12 }), '2FA on')
          : el('span', { class: 'pill' }, icon('lock', { size: 12 }), '2FA off'),
      ),
    ),
  );

  /* ---------------------------------------------------------- profile */
  const profile = el('div', { class: 'panel' });
  profile.append(el('h3', {}, 'Profile'));
  profile.append(el('p', { class: 'hint' }, 'How your name appears in the interface.'));

  const displayName = el('input', { type: 'text', value: state.user?.displayName || '', placeholder: 'Display name' });
  const profileForm = el(
    'form',
    {},
    el('div', { class: 'field' }, el('label', {}, 'Display name'), displayName),
    el('button', { class: 'btn btn--accent btn--sm', type: 'submit' }, 'Save'),
  );
  const profileAlert = el('div', { class: 'alert alert--error', hidden: true });
  profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    profileAlert.hidden = true;
    try {
      const res = await api.patch(`/api/auth/users/${state.user.id}`, {
        displayName: displayName.value.trim() || null,
      });
      // The API returns both spellings, but be defensive about it.
      state.user.displayName = res.user.displayName ?? res.user.display_name ?? null;
      syncUserUI();
      toast('Profile updated', 'ok');
    } catch (err) {
      profileAlert.textContent = err.message;
      profileAlert.hidden = false;
    }
  });
  profile.append(profileAlert, profileForm);
  panel.append(profile);

  /* --------------------------------------------------------- password */
  const password = el('div', { class: 'panel' });
  password.append(el('h3', {}, 'Password'));
  password.append(el('p', { class: 'hint' }, 'Changing your password signs out your other devices.'));

  const currentPassword = el('input', { type: 'password', placeholder: 'current password' });
  const newPassword = el('input', { type: 'password', placeholder: 'new password (min 8 characters)' });
  const passwordAlert = el('div', { class: 'alert alert--error', hidden: true });
  const passwordForm = el(
    'form',
    {},
    passwordAlert,
    el('div', { class: 'field' }, el('label', {}, 'Current password'), currentPassword),
    el('div', { class: 'field' }, el('label', {}, 'New password'), newPassword),
    el('button', { class: 'btn btn--accent btn--sm', type: 'submit' }, 'Change password'),
  );
  passwordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    passwordAlert.hidden = true;
    try {
      await api.patch(`/api/auth/users/${state.user.id}`, {
        password: newPassword.value,
      });
      // The server keeps this session and revokes the other ones, so there
      // is no need to sign out here.
      toast('Password changed — the other devices were signed out', 'ok');
      newPassword.value = '';
      currentPassword.value = '';
    } catch (err) {
      passwordAlert.textContent = err.message;
      passwordAlert.hidden = false;
    }
  });
  password.append(passwordForm);
  panel.append(password);

  /* -------------------------------------------------------------- 2FA */
  const twofa = el('div', { class: 'panel panel--wide' });
  twofa.append(el('h3', {}, 'Two-factor authentication'));
  twofa.append(
    el(
      'p',
      { class: 'hint' },
      'Add a second step to sign-in: a 6-digit code from an authenticator app (Google Authenticator, Aegis, Authy…).',
    ),
  );

  const twofaBody = el('div', {});
  twofa.append(twofaBody);

  async function renderTwofa() {
    clear(twofaBody);
    const me = await api.get('/api/auth/me');
    const enabled = Boolean(me.user.totpEnabled);

    if (enabled) {
      twofaBody.append(el('span', { class: 'pill pill--ok' }, icon('shield', { size: 12 }), 'Enabled'));
      const disable = el('button', { class: 'btn btn--danger btn--sm', style: { marginLeft: '10px' } },
        icon('ban', { size: 14 }), 'Disable');
      disable.addEventListener('click', async () => {
        const code = prompt('Enter a current code from your app to confirm:');
        if (!code) return;
        try {
          await api.post('/api/auth/2fa/disable', { code: code.trim() });
          toast('Two-factor authentication disabled', 'ok');
          renderTwofa();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      twofaBody.append(disable);
      return;
    }

    const setupBtn = el('button', { class: 'btn btn--accent btn--sm' }, icon('shield', { size: 14 }), 'Set up two-factor');
    setupBtn.addEventListener('click', async () => {
      try {
        const data = await api.post('/api/auth/2fa/setup');
        clear(twofaBody);
        twofaBody.append(
          el('p', { class: 'hint' }, 'Add this secret to your authenticator app, then enter the code it shows:'),
          el(
            'div',
            {
              style: {
                fontFamily: 'ui-monospace, monospace',
                fontSize: '15px',
                wordBreak: 'break-all',
                background: 'var(--bg)',
                padding: '12px',
                borderRadius: '10px',
                border: '1px solid var(--line)',
                marginBottom: '12px',
              },
            },
            data.secret,
          ),
          el(
            'p',
            { class: 'hint' },
            'Or import this link: ',
            el('a', { href: data.uri, style: { color: 'var(--accent)' } }, data.uri.slice(0, 48) + '…'),
          ),
        );

        const code = el('input', { type: 'text', placeholder: '123456', maxlength: '8', inputmode: 'numeric' });
        const confirmBtn = el('button', { class: 'btn btn--accent btn--sm', style: { marginTop: '10px' } }, 'Confirm');
        const cancelBtn = el('button', { class: 'btn btn--ghost btn--sm', style: { marginTop: '10px', marginLeft: '8px' } }, 'Cancel');
        const alert = el('div', { class: 'alert alert--error', hidden: true, style: { marginTop: '10px' } });

        confirmBtn.addEventListener('click', async () => {
          alert.hidden = true;
          try {
            await api.post('/api/auth/2fa/enable', { code: code.value.trim() });
            toast('Two-factor authentication enabled', 'ok');
            renderTwofa();
          } catch (err) {
            alert.textContent = err.message;
            alert.hidden = false;
          }
        });
        cancelBtn.addEventListener('click', () => renderTwofa());

        twofaBody.append(
          el('div', { class: 'field' }, el('label', {}, '6-digit code'), code),
          alert,
          confirmBtn,
          cancelBtn,
        );
        code.focus();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    twofaBody.append(setupBtn);
  }
  renderTwofa();
  panel.append(twofa);
}
