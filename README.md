# SoundSeek

TikTok-Link einfügen, Song erkennen lassen, bei Spotify / Apple Music / Deezer öffnen.
Läuft als installierbare Web-App (PWA) über GitHub Pages.

- **Frontend** — statische Seite im Wurzelverzeichnis, ausgeliefert von GitHub Pages
- **Backend** — ein Cloudflare Worker in `worker/`, der den AudD-Token geheim hält

Die Erkennung übernimmt [AudD](https://audd.io). SoundSeek stellt keine gekauften Titel bereit:
es zeigt, welcher Song läuft, verlinkt ihn bei den Streamingdiensten und kann den TikTok-Beitrag
selbst (Sound-Ausschnitt und Video) herunterladen.

---

## Einrichtung

Zwei Teile, einmal je zehn Minuten. Danach nie wieder.

### 1. Backend auf Cloudflare

```bash
cd worker
npm install
npx wrangler login          # öffnet den Browser, einmal bestätigen
npx wrangler secret put AUDD_API_TOKEN   # AudD-Token einfügen, Enter
npm run deploy
```

Am Ende steht eine Adresse in der Ausgabe, etwa
`https://soundseek-api.dein-name.workers.dev`. Die wird gleich gebraucht.

Kurz prüfen: `https://soundseek-api.dein-name.workers.dev/api/health` muss
`{"ok":true,"configured":true}` liefern. Steht dort `"configured":false`, fehlt das Secret.

### 2. Frontend auf GitHub Pages

1. In `config.js` bei `apiBase` die Worker-Adresse eintragen (ohne Slash am Ende), committen, pushen.
2. Im Repo unter **Settings → Pages**: Source auf **Deploy from a branch**, Branch `main`, Ordner `/ (root)`.
3. Nach ein bis zwei Minuten läuft die Seite unter `https://<dein-github-name>.github.io/soundseek/`.

### 3. Backend abriegeln (empfohlen)

Solange `ALLOWED_ORIGINS` auf `*` steht, kann jede Seite dein AudD-Kontingent verbrauchen.
In `worker/wrangler.toml` deshalb eintragen:

```toml
[vars]
ALLOWED_ORIGINS = "https://<dein-github-name>.github.io"
```

Dann `npm run deploy` im Ordner `worker/` erneut ausführen.

### 4. Auf dem Handy installieren

Seite im Browser öffnen → Teilen → **Zum Home-Bildschirm**. Danach liegt sie wie eine App
auf dem Startbildschirm.

Auf Android taucht SoundSeek danach auch im Teilen-Menü von TikTok auf: Video teilen →
SoundSeek → die Erkennung startet von allein.

---

## Aufbau

| Datei | Zweck |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | die Oberfläche |
| `config.js` | die einzige Datei mit einer Einstellung: die Backend-Adresse |
| `manifest.webmanifest`, `sw.js`, `icons/` | alles, was die Seite installierbar macht |
| `worker/src/index.js` | das Backend |
| `scripts/build-icons.mjs` | erzeugt die Icon-PNGs neu, wenn `icons/icon.svg` sich ändert |
| `scripts/smoke.mjs` | Sichtprüfung der Oberfläche mit erfundenen Daten |

### Endpunkte des Workers

| Endpunkt | Zweck |
| --- | --- |
| `POST /api/identify` `{ "url": "..." }` | erkennt den Song hinter einem TikTok-Link |
| `GET /api/download?u=&name=` | reicht TikTok-Medien mit Download-Header durch |
| `GET /api/health` | Selbsttest |

Der Download-Endpunkt nimmt nur Adressen von TikToks eigenen CDN-Hosts an — sonst wäre der
Worker ein offener Proxy für beliebige Dateien.

---

## Wenn etwas nicht geht

**„Kein Treffer"** — passiert bei Original-Sounds ohne Musik, wenn jemand laut über den Song
redet, oder bei sehr kurzen Clips. Kein Fehler, sondern die Grenze der Erkennung.

**„Das Backend war nicht erreichbar"** — Adresse in `config.js` prüfen (oder in der App über das
Zahnrad). Danach `/api/health` im Browser aufrufen.

**„Das AudD-Kontingent ist aufgebraucht"** — Zählerstand im AudD-Dashboard prüfen.

**Download bleibt leer** — TikTok ändert regelmäßig etwas an seinen Adressen. Die Erkennung
läuft davon unabhängig weiter; betroffen ist nur `fetchMedia` im Worker.

---

## Entwicklung

```bash
npx http-server -p 8080 .        # Frontend
cd worker && npx wrangler dev    # Backend auf localhost:8787
node scripts/smoke.mjs           # Sichtprüfung, legt Screenshots in /tmp
```

Für den lokalen Betrieb im Worker-Ordner eine `.dev.vars` anlegen:

```
AUDD_API_TOKEN=dein-token
```

Die Datei ist in `.gitignore` — sie gehört nicht ins Repo.
