import { api, setToken } from '../api.js';
import { el, clear, toast } from '../dom.js';
import { icon } from '../icons.js';
import { state, syncUserUI } from '../app.js';

/** Login / first-run registration screen. */
export function renderLogin(root) {
  clear(root);

  let mode = 'login';
  let pendingTotp = false;

  const screen = el('div', { class: 'auth-screen' });
  const card = el('div', { class: 'auth-card' });
  screen.append(card);
  root.append(screen);

  function draw() {
    clear(card);

    const alert = el('div', { class: 'alert alert--error', hidden: true });

    const username = el('input', { type: 'text', id: 'login-username', autocomplete: 'username', required: true });
    const password = el('input', { type: 'password', id: 'login-password', autocomplete: 'current-password', required: true });
    const displayName = el('input', { type: 'text', id: 'login-display', autocomplete: 'name' });
    const totp = el('input', {
      type: 'text', id: 'login-totp', autocomplete: 'one-time-code',
      inputmode: 'numeric', pattern: '[0-9]*', maxlength: '8', placeholder: '123456',
    });

    card.append(
      el('h1', {}, icon(pendingTotp ? 'shield' : 'film', { size: 24 }),
        pendingTotp ? 'Two-factor' : mode === 'login' ? 'Sign in' : 'Create account'),
      el(
        'p',
        { class: 'sub' },
        pendingTotp
          ? 'Enter the 6-digit code from your authenticator app.'
          : mode === 'login'
            ? 'Access your movie library.'
            : 'The first account created becomes the administrator.',
      ),
      alert,
    );

    const submit = el('button', { class: 'btn btn--accent btn--block', type: 'submit' }, pendingTotp ? 'Verify' : mode === 'login' ? 'Sign in' : 'Create account');
    const form = el('form', { class: 'form' });
    card.append(form);

    if (pendingTotp) {
      form.append(
        el('div', { class: 'field' }, el('label', { for: 'login-totp' }, 'Authentication code'), totp),
      );
    } else {
      // Fields live inside the form so the browser handles Enter-to-submit and
      // password managers recognise the inputs correctly.
      form.append(
        el('div', { class: 'field' }, el('label', { for: 'login-username' }, 'Username'), username),
        el('div', { class: 'field' }, el('label', { for: 'login-password' }, 'Password'), password),
      );

      if (mode === 'register') {
        form.append(
          el('div', { class: 'field' }, el('label', { for: 'login-display' }, 'Display name (optional)'), displayName),
        );
      }
    }

    form.append(submit);

    if (!pendingTotp) {
      card.append(
        el(
          'div',
          { class: 'auth-card__switch' },
          mode === 'login' ? 'No account yet? ' : 'Already have an account? ',
          el(
            'button',
            {
              type: 'button',
              onClick: () => {
                mode = mode === 'login' ? 'register' : 'login';
                draw();
              },
            },
            mode === 'login' ? 'Create one' : 'Sign in',
          ),
        ),
      );
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      alert.hidden = true;
      submit.disabled = true;
      submit.textContent = pendingTotp ? 'Verifying…' : mode === 'login' ? 'Signing in…' : 'Creating…';

      const payload = pendingTotp
        ? { username, password, totp: totp.value.trim() }
        : { username: username.value.trim(), password: password.value };
      if (mode === 'register' && !pendingTotp) payload.displayName = displayName.value.trim() || null;

      try {
        const data = await api.post(
          mode === 'login' ? '/api/auth/login' : '/api/auth/register',
          payload,
        );
        setToken(data.token);
        state.user = data.user;
        state.progress.clear();
        syncUserUI();
        toast(`Welcome, ${data.user.username}!`, 'ok');
        location.hash = '#/';
      } catch (err) {
        // A 2FA challenge switches the form into code-entry mode.
        if (err.body?.requiresTotp) {
          pendingTotp = true;
          draw();
          const field = document.getElementById('login-totp');
          if (field) field.focus();
          return;
        }
        alert.textContent = err.message;
        alert.hidden = false;
        submit.disabled = false;
        submit.textContent = pendingTotp ? 'Verify' : mode === 'login' ? 'Sign in' : 'Create account';
      }
    });

    setTimeout(() => {
      const first = pendingTotp ? totp : username;
      first?.focus();
    }, 40);
  }

  draw();
}
