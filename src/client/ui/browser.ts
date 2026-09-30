import { previewUrl } from '../../shared/local-sessions';
import { h, openModal } from './dom';

/** A sandboxed browsing surface; framed sites cannot reach the office or its session APIs. */
export function openOfficeBrowser(initial = '') {
  const input = h('input', { type: 'text', placeholder: 'http://localhost:3000', 'aria-label': 'Browser address', autocomplete: 'off' });
  input.value = initial;
  const open = h('a.btn', { target: '_blank', rel: 'noopener noreferrer', hidden: true }, 'Open in tab');
  const note = h('p.setting-note', {}, 'Open a local preview or paste a web address. Sites that block embedding can be opened in a tab.');
  const viewport = h('div.office-browser-viewport', {}, h('div.browser-empty', {}, h('span', {}, '🌐'), h('h3', {}, 'A window into their work'), h('p', {}, 'Paste a preview URL above, or choose a link from a coworker.')));
  const form = h('form.office-browser-address', {}, input, h('button.btn.primary', { type: 'submit' }, 'Go'), open);
  let frame: HTMLIFrameElement | undefined;
  const navigate = () => {
    const url = previewUrl(input.value.includes('://') ? input.value : `http://${input.value}`);
    if (!url) { note.textContent = 'Enter an http:// or https:// address without credentials.'; return; }
    if (new URL(url).origin === location.origin) { note.textContent = 'The office is already open here. Choose a different preview address.'; return; }
    input.value = url;
    open.href = url; open.hidden = false;
    note.textContent = 'If the page stays blank or asks to sign in, use Open in tab. Some sites do not allow embedded browsers.';
    frame?.remove();
    frame = h('iframe', { src: url, title: 'Coworker web preview', sandbox: 'allow-scripts allow-forms allow-popups allow-downloads', referrerpolicy: 'no-referrer' });
    viewport.replaceChildren(frame);
  };
  const modal = openModal(h('div.modal.office-browser', { role: 'dialog', 'aria-label': 'Office browser' }, h('header', {}, h('h2', {}, '🌐 Office browser')), form, note, viewport), { onClose: () => frame?.remove() });
  form.addEventListener('submit', (event) => { event.preventDefault(); navigate(); });
  if (initial) navigate();
  else input.focus();
  return modal;
}
