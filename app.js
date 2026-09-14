/* SoundSeek — Frontend */

const API_STORAGE_KEY = 'soundseek.apiBase';

const form = document.getElementById('search-form');
const input = document.getElementById('link-input');
const submitButton = document.getElementById('submit-button');
const pasteButton = document.getElementById('paste-button');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const settingsEl = document.getElementById('settings');
const settingsToggle = document.getElementById('settings-toggle');
const apiInput = document.getElementById('api-input');
const apiSave = document.getElementById('api-save');
const apiCurrent = document.getElementById('api-current');

/* --------------------------------------------------------- Backend-Adresse */

function configuredApiBase() {
  const fromConfig = (window.SOUNDSEEK_CONFIG && window.SOUNDSEEK_CONFIG.apiBase) || '';
  return fromConfig.trim().replace(/\/+$/, '');
}

function storedApiBase() {
  try {
    return (localStorage.getItem(API_STORAGE_KEY) || '').trim().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function apiBase() {
  return storedApiBase() || configuredApiBase();
}

function refreshApiHint() {
  const base = apiBase();
  apiCurrent.textContent = base ? `Aktuell: ${base}` : 'Noch keine Adresse hinterlegt.';
  apiInput.value = storedApiBase();
}

/* ------------------------------------------------------------------ Status */

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('is-error', isError);
}

function setBusy(busy) {
  submitButton.disabled = busy;
  submitButton.classList.toggle('is-busy', busy);
  submitButton.querySelector('.label').textContent = busy ? 'Suche läuft' : 'Song finden';
}

/* ---------------------------------------------------------------- Rendering */

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
}

function year(dateString) {
  const match = String(dateString || '').match(/\d{4}/);
  return match ? match[0] : '';
}

function downloadUrl(mediaUrl, filename) {
  return `${apiBase()}/api/download?u=${encodeURIComponent(mediaUrl)}&name=${encodeURIComponent(filename)}`;
}

function renderResult(data) {
  const song = data.song;
  const media = data.media || {};

  const meta = [song.album, year(song.releaseDate), song.label].filter(Boolean).join(' · ');
  const cover = song.cover || media.cover || '';

  const streamingLinks = [
    ['Spotify', song.links.spotify],
    ['Apple Music', song.links.appleMusic],
    ['Deezer', song.links.deezer],
    ['YouTube Music', song.links.youtube],
  ].filter(([, href]) => Boolean(href));

  const downloads = [];
  if (media.soundUrl) {
    const name = [song.artist, song.title].filter(Boolean).join(' - ') || 'sound';
    downloads.push(['TikTok-Sound (Ausschnitt)', downloadUrl(media.soundUrl, name)]);
  }
  if (media.videoUrl) {
    const name = `TikTok - ${media.author || 'video'}`;
    downloads.push(['Video ohne Wasserzeichen', downloadUrl(media.videoUrl, name)]);
  }

  resultEl.innerHTML = `
    <div class="song">
      ${cover ? `<img src="${escapeHtml(cover)}" alt="Cover von ${escapeHtml(song.title || 'dem Song')}" loading="lazy" />` : ''}
      <div class="song-text">
        <h2 class="song-title">${escapeHtml(song.title || 'Unbekannter Titel')}</h2>
        <p class="song-artist">${escapeHtml(song.artist || 'Unbekannter Artist')}</p>
        ${meta ? `<p class="song-meta">${escapeHtml(meta)}</p>` : ''}
      </div>
    </div>

    ${song.previewUrl ? `<audio controls preload="none" src="${escapeHtml(song.previewUrl)}"></audio>` : ''}

    <div>
      <p class="group-label">Ganzer Song anhören</p>
      <div class="links">
        ${streamingLinks
          .map(
            ([label, href]) =>
              `<a class="link-button" href="${escapeHtml(href)}" target="_blank" rel="noopener">${label}</a>`,
          )
          .join('')}
      </div>
    </div>

    ${
      downloads.length
        ? `<hr class="divider" />
    <div>
      <p class="group-label">Vom TikTok herunterladen</p>
      <div class="links">
        ${downloads
          .map(([label, href]) => `<a class="link-button" href="${escapeHtml(href)}">${label}</a>`)
          .join('')}
      </div>
      <p class="note">
        Das ist der Beitrag selbst, nicht der gekaufte Titel. Den ganzen Song bekommst du über die
        Links darüber.
      </p>
    </div>`
        : ''
    }
  `;

  resultEl.hidden = false;
}

function renderNothing() {
  resultEl.hidden = true;
  resultEl.innerHTML = '';
}

/* ----------------------------------------------------------------- Ablauf */

async function identify(rawUrl) {
  const base = apiBase();
  if (!base) {
    setStatus('Es ist noch keine Backend-Adresse hinterlegt — siehe Einstellungen oben rechts.', true);
    settingsEl.hidden = false;
    settingsEl.open = true;
    return;
  }

  renderNothing();
  setBusy(true);
  setStatus('Song wird erkannt — das dauert ein paar Sekunden.');

  try {
    const res = await fetch(`${base}/api/identify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: rawUrl }),
    });

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('Das Backend hat keine gültige Antwort geliefert.');
    }

    if (!data.ok) {
      setStatus(data.message || 'Das hat nicht geklappt.', true);
      return;
    }

    setStatus('');
    renderResult(data);
  } catch (err) {
    setStatus(
      `Das Backend war nicht erreichbar (${err.message}). Adresse in den Einstellungen prüfen.`,
      true,
    );
  } finally {
    setBusy(false);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = input.value.trim();
  if (value) identify(value);
});

pasteButton.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      input.value = text.trim();
      input.focus();
      setStatus('');
    }
  } catch {
    setStatus('Der Browser gibt die Zwischenablage nicht frei — bitte von Hand einfügen.', true);
  }
});

settingsToggle.addEventListener('click', () => {
  const nowVisible = settingsEl.hidden;
  settingsEl.hidden = !nowVisible;
  settingsEl.open = nowVisible;
  settingsToggle.setAttribute('aria-expanded', String(nowVisible));
  if (nowVisible) refreshApiHint();
});

apiSave.addEventListener('click', () => {
  const value = apiInput.value.trim().replace(/\/+$/, '');
  try {
    if (value) localStorage.setItem(API_STORAGE_KEY, value);
    else localStorage.removeItem(API_STORAGE_KEY);
    setStatus(value ? 'Backend-Adresse gespeichert.' : 'Eigene Adresse entfernt.');
  } catch {
    setStatus('Der Browser erlaubt kein Speichern — die Adresse gilt nur für diesen Besuch.', true);
    window.SOUNDSEEK_CONFIG = { ...(window.SOUNDSEEK_CONFIG || {}), apiBase: value };
  }
  refreshApiHint();
});

/* ------------------------------------------- Aus TikTok heraus "Teilen an" */

const shared = new URLSearchParams(location.search).get('url');
if (shared) {
  input.value = shared;
  history.replaceState(null, '', location.pathname);
  identify(shared);
}

refreshApiHint();
if (!apiBase()) {
  settingsEl.hidden = false;
  setStatus('Trag einmalig die Adresse deines Cloudflare Workers ein (Zahnrad oben rechts).');
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* Offline-Modus ist optional — ohne ihn funktioniert die Seite genauso. */
    });
  });
}
