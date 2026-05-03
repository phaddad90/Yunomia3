// Yunomia auto-updater. Checks the GitHub releases manifest on boot and
// surfaces a banner if a newer version is available.
//
// Update flow:
//   1. tauri-plugin-updater fetches latest.json from the configured endpoint.
//   2. Manifest is verified against the public key baked into tauri.conf.json.
//   3. If newer version available, banner offers Download + Install.
//   4. Plugin downloads + installs the signed package.
//   5. Plugin restarts the app via tauri-plugin-process.

import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

const LS_LAST_CHECK = 'yunomia.lastUpdateCheck';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;   // every 6 hours

export async function bootCheckForUpdates({ silent = true } = {}) {
  // Throttle background checks; manual checks always run.
  if (silent) {
    const last = parseInt(localStorage.getItem(LS_LAST_CHECK) || '0', 10);
    if (Date.now() - last < CHECK_INTERVAL_MS) return null;
    localStorage.setItem(LS_LAST_CHECK, String(Date.now()));
  }
  let update;
  try {
    update = await check();
  } catch (err) {
    if (!silent) alert('Update check failed: ' + (err?.message || err));
    return null;
  }
  if (!update) return null;
  showUpdateBanner(update);
  return update;
}

function showUpdateBanner(update) {
  // Avoid duplicate banners.
  document.querySelectorAll('.update-banner').forEach((b) => b.remove());
  const banner = document.createElement('div');
  banner.className = 'update-banner';
  banner.innerHTML = `
    <span class="update-icon">⬆</span>
    <span>Yunomia <b>${escapeHtml(update.version)}</b> is available
      ${update.date ? `<span class="update-when">released ${escapeHtml(update.date.slice(0,10))}</span>` : ''}
    </span>
    <button class="update-install btn-primary" type="button">Install &amp; restart</button>
    <button class="update-later btn-ghost" type="button">Later</button>
  `;
  document.body.insertBefore(banner, document.body.firstChild);

  banner.querySelector('.update-install').addEventListener('click', async () => {
    const btn = banner.querySelector('.update-install');
    btn.disabled = true;
    btn.textContent = 'Downloading…';
    let downloaded = 0;
    let totalSize = 0;
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            totalSize = event.data.contentLength || 0;
            break;
          case 'Progress':
            downloaded += event.data.chunkLength || 0;
            if (totalSize) {
              const pct = Math.round((downloaded / totalSize) * 100);
              btn.textContent = `Downloading ${pct}%`;
            }
            break;
          case 'Finished':
            btn.textContent = 'Restarting…';
            break;
        }
      });
      await relaunch();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Install & restart';
      alert('Update failed: ' + (err?.message || err));
    }
  });
  banner.querySelector('.update-later').addEventListener('click', () => banner.remove());
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
