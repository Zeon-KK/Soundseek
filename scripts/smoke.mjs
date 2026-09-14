/**
 * Sichtprüfung: laedt die Seite, spielt eine erfundene Server-Antwort ein und
 * legt zwei Screenshots ab. Nur fuer die Entwicklung.
 *   node scripts/smoke.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8080';
const OUT = process.env.SMOKE_OUT || '/tmp';

const fakeResponse = {
  ok: true,
  source: 'https://www.tiktok.com/@example/video/123',
  song: {
    title: 'Beispieltitel',
    artist: 'Beispiel-Artist',
    album: 'Beispiel-Album',
    releaseDate: '2024-03-15',
    label: 'Beispiel Records',
    cover: null,
    links: {
      spotify: 'https://open.spotify.com/',
      appleMusic: 'https://music.apple.com/',
      deezer: 'https://www.deezer.com/',
      youtube: 'https://music.youtube.com/',
      songLink: null,
    },
    previewUrl: null,
  },
  media: {
    cover: null,
    author: 'beispielkonto',
    soundUrl: 'https://v16.tiktokcdn.com/beispiel.mp3',
    videoUrl: 'https://v16.tiktokcdn.com/beispiel.mp4',
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 414, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

await page.route('**/api/identify', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fakeResponse) }),
);

await page.addInitScript(() => {
  localStorage.setItem('soundseek.apiBase', 'https://backend.example.workers.dev');
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.screenshot({ path: `${OUT}/soundseek-start.png`, fullPage: true });

await page.fill('#link-input', 'https://www.tiktok.com/@example/video/123');
await page.click('#submit-button');
await page.waitForSelector('#result .song-title', { timeout: 5000 });
await page.screenshot({ path: `${OUT}/soundseek-result.png`, fullPage: true });

const downloadHref = await page.getAttribute('#result .links a[href*="/api/download"]', 'href');
console.log('Download-Link:', downloadHref);
console.log(errors.length ? `FEHLER:\n${errors.join('\n')}` : 'keine Konsolenfehler');

await browser.close();
