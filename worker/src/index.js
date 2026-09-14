/**
 * SoundSeek API — Cloudflare Worker
 *
 * Zwei Endpunkte:
 *   POST /api/identify  { url }   -> erkennt den Song hinter einem TikTok-Link
 *   GET  /api/download?u=&name=   -> reicht TikTok-Medien mit Download-Header durch
 *
 * Der AudD-Token liegt als Secret im Worker und verlässt ihn nie.
 */

const WORKER_VERSION = 5;

const AUDD_ENDPOINT = 'https://api.audd.io/';
const TIKWM_ENDPOINT = 'https://www.tikwm.com/api/';

// Hosts, von denen der Download-Proxy ausliefern darf. Ohne diese Liste wäre
// der Worker ein offener Proxy, über den jeder beliebige Dateien saugen kann.
const ALLOWED_MEDIA_HOSTS = [
  /(^|\.)tiktokcdn\.com$/,
  /(^|\.)tiktokcdn-us\.com$/,
  /(^|\.)tiktokcdn-eu\.com$/,
  /(^|\.)tiktokv\.com$/,
  /(^|\.)tiktokvcdn\.com$/,
  /(^|\.)muscdn\.com$/,
  /(^|\.)tikwm\.com$/,
];

const TIKTOK_HOSTS = [/(^|\.)tiktok\.com$/];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === '/api/identify' && request.method === 'POST') {
        return await handleIdentify(request, env, cors);
      }
      if (url.pathname === '/api/download' && request.method === 'GET') {
        return await handleDownload(url, cors);
      }
      if (url.pathname === '/api/debug' && request.method === 'GET') {
        return await handleDebug(url, cors);
      }
      if (url.pathname === '/api/health') {
        return json(
          {
            ok: true,
            configured: Boolean(env.AUDD_API_TOKEN),
            // Hochzaehlen, wenn sich am Worker etwas aendert: so ist von aussen
            // sichtbar, ob ein Deploy wirklich angekommen ist.
            version: WORKER_VERSION,
            allowedOrigins: env.ALLOWED_ORIGINS || '*',
          },
          200,
          cors,
        );
      }
    } catch (err) {
      return json(
        { ok: false, error: 'server_error', message: String((err && err.message) || err) },
        500,
        cors,
      );
    }

    return json({ ok: false, error: 'not_found' }, 404, cors);
  },
};

/* ---------------------------------------------------------------- identify */

async function handleIdentify(request, env, cors) {
  if (!env.AUDD_API_TOKEN) {
    return json(
      {
        ok: false,
        error: 'not_configured',
        message: 'Auf dem Server fehlt das Secret AUDD_API_TOKEN.',
      },
      500,
      cors,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad_request', message: 'Body ist kein JSON.' }, 400, cors);
  }

  const tiktokUrl = normalizeTikTokUrl(body && body.url);
  if (!tiktokUrl) {
    return json(
      {
        ok: false,
        error: 'invalid_url',
        message: 'Das sieht nicht nach einem TikTok-Link aus.',
      },
      400,
      cors,
    );
  }

  // Kurzlinks (vm.tiktok.com) sind nur Weiterleitungen — erst aufloesen.
  const resolved = await resolveShortLink(tiktokUrl);

  // Medien zuerst: AudD will eine echte Audiodatei, keine Webseite. Der
  // Sound-Download aus dem Beitrag ist genau das.
  const media = await fetchMedia(resolved).catch(() => null);

  // Jeder Versuch kostet eine Anfrage beim Erkennungsdienst, also so wenige wie
  // moeglich: mit echter Audiospur reicht diese (plus Video als Reserve). Die
  // Seite selbst ist nur dran, wenn sich gar keine Medien holen liessen — an ihr
  // scheitert AudD ohnehin meistens.
  const fromMedia = [media && media.soundUrl, media && media.videoUrl].filter(Boolean);
  const candidates = fromMedia.length ? fromMedia : [resolved];
  const recognition = await recognize(candidates, env);

  if (!recognition.ok) {
    // "tried" sagt bei der Fehlersuche, woran es lag: an der Tonspur oder
    // daran, dass sich gar keine holen liess.
    return json(
      { ...recognition, media, source: resolved, tried: candidates },
      recognition.status || 502,
      cors,
    );
  }

  return json({ ok: true, song: recognition.song, media, source: resolved }, 200, cors);
}

/**
 * Folgt der Weiterleitung hinter einem Kurzlink. Schlaegt das fehl, bleibt der
 * urspruengliche Link stehen — tikwm kommt mit beidem klar.
 */
async function resolveShortLink(tiktokUrl) {
  if (!/^https:\/\/(vm|vt|m)\.tiktok\.com\//i.test(tiktokUrl)) return tiktokUrl;

  try {
    const res = await fetch(tiktokUrl, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; SoundSeek/1.0)' },
    });
    if (res.url && /tiktok\.com/.test(res.url)) {
      const clean = new URL(res.url);
      clean.search = '';
      clean.hash = '';
      return clean.toString();
    }
  } catch {
    /* Weiterleitung nicht erreichbar — dann eben mit dem Kurzlink weiter. */
  }
  return tiktokUrl;
}

/**
 * Probiert der Reihe nach mehrere Quellen: erst die reine Audiodatei, dann das
 * Video, zuletzt die Seite selbst. Die erste, die einen Treffer liefert, gewinnt.
 */
async function recognize(candidates, env) {
  let noMatch = null;
  let lastError = null;

  for (const candidate of candidates) {
    const outcome = await recognizeOne(candidate, env);
    if (outcome.ok) return outcome;
    // Token abgelehnt oder Kontingent leer — weitere Versuche bringen nichts.
    if (outcome.fatal) return outcome;
    if (outcome.error === 'no_match') noMatch = noMatch || outcome;
    lastError = outcome;
  }

  // "Kein Treffer" ist die aussagekraeftigere Antwort als ein technischer Fehler.
  return (
    noMatch ||
    lastError || {
      ok: false,
      error: 'no_source',
      message: 'Aus diesem Beitrag liess sich keine Audiospur holen.',
      status: 502,
    }
  );
}

async function recognizeOne(sourceUrl, env) {
  const params = new URLSearchParams({
    api_token: env.AUDD_API_TOKEN,
    url: sourceUrl,
    return: 'apple_music,spotify,deezer',
    market: env.AUDD_MARKET || 'de',
  });

  const res = await fetch(AUDD_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    return {
      ok: false,
      error: 'audd_unavailable',
      message: 'AudD hat keine gültige Antwort geliefert.',
      status: 502,
    };
  }

  if (data.status === 'error') {
    const code = data.error && data.error.error_code;
    // 900 = Token wird nicht akzeptiert, 901 = Kontingent aufgebraucht.
    // Beides betrifft das Konto, nicht die Quelle — weiterprobieren ist sinnlos.
    const fatal = code === 900 || code === 901;
    const message =
      code === 901
        ? 'Das AudD-Kontingent ist aufgebraucht.'
        : code === 900
          ? 'Der AudD-Token wird nicht akzeptiert.'
          : 'Aus diesem Beitrag liess sich kein Fingerabdruck der Musik erzeugen.';

    return {
      ok: false,
      error: 'audd_error',
      code,
      fatal,
      message,
      detail: (data.error && data.error.error_message) || null,
      status: 502,
    };
  }

  if (!data.result) {
    return {
      ok: false,
      error: 'no_match',
      message:
        'Kein Treffer. Das passiert bei Original-Sounds, viel Gerede über der Musik oder sehr kurzen Clips.',
      status: 404,
    };
  }

  return { ok: true, song: shapeSong(data.result) };
}

function shapeSong(r) {
  const apple = r.apple_music || null;
  const spotify = r.spotify || null;
  const deezer = r.deezer || null;

  const cover =
    (apple &&
      apple.artwork &&
      apple.artwork.url &&
      apple.artwork.url.replace('{w}', '600').replace('{h}', '600')) ||
    (spotify &&
      spotify.album &&
      spotify.album.images &&
      spotify.album.images[0] &&
      spotify.album.images[0].url) ||
    (deezer && deezer.album && (deezer.album.cover_big || deezer.album.cover_medium)) ||
    null;

  const query = encodeURIComponent(`${r.artist || ''} ${r.title || ''}`.trim());

  return {
    title: r.title || null,
    artist: r.artist || null,
    album: r.album || (apple && apple.albumName) || null,
    releaseDate: r.release_date || (apple && apple.releaseDate) || null,
    label: r.label || null,
    timecode: r.timecode || null,
    cover,
    links: {
      spotify: (spotify && spotify.external_urls && spotify.external_urls.spotify) || null,
      appleMusic: (apple && apple.url) || null,
      deezer: (deezer && deezer.link) || null,
      youtube: `https://music.youtube.com/search?q=${query}`,
      songLink: r.song_link || null,
    },
    previewUrl:
      (apple && apple.previews && apple.previews[0] && apple.previews[0].url) ||
      (deezer && deezer.preview) ||
      null,
  };
}

/* ------------------------------------------------------------------- debug */

/**
 * Zeigt, was sich aus einem Beitrag herausholen laesst, ohne den
 * Erkennungsdienst anzufassen — kostet also nichts vom Kontingent.
 * Gedacht fuer die Fehlersuche, wenn eine Erkennung scheitert.
 */
async function handleDebug(url, cors) {
  const tiktokUrl = normalizeTikTokUrl(url.searchParams.get('url'));
  if (!tiktokUrl) {
    return json(
      { ok: false, error: 'invalid_url', message: 'Das sieht nicht nach einem TikTok-Link aus.' },
      400,
      cors,
    );
  }

  const resolved = await resolveShortLink(tiktokUrl);

  let media = null;
  let mediaError = null;
  try {
    media = await fetchMedia(resolved);
  } catch (err) {
    mediaError = String((err && err.message) || err);
  }

  const fromMedia = [media && media.soundUrl, media && media.videoUrl].filter(Boolean);

  return json(
    {
      ok: true,
      version: WORKER_VERSION,
      input: tiktokUrl,
      resolved,
      shortLinkResolved: resolved !== tiktokUrl,
      mediaFound: Boolean(media),
      mediaError,
      media,
      // Genau diese Quellen wuerde die Erkennung der Reihe nach probieren.
      wouldTry: fromMedia.length ? fromMedia : [resolved],
    },
    200,
    cors,
  );
}

/* ------------------------------------------------------------------- media */

async function fetchMedia(tiktokUrl) {
  const res = await fetch(`${TIKWM_ENDPOINT}?url=${encodeURIComponent(tiktokUrl)}&hd=1`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; SoundSeek/1.0)' },
  });
  if (!res.ok) return null;

  const data = await res.json();
  if (!data || data.code !== 0 || !data.data) return null;

  const d = data.data;
  return {
    cover: d.cover || d.origin_cover || null,
    caption: d.title || null,
    author: d.author ? d.author.nickname || d.author.unique_id || null : null,
    duration: d.duration || null,
    soundTitle: d.music_info ? d.music_info.title || null : null,
    soundUrl: absolutize(d.music || (d.music_info && d.music_info.play)),
    videoUrl: absolutize(d.hdplay || d.play),
  };
}

function absolutize(u) {
  if (!u) return null;
  if (u.startsWith('https://')) return u;
  if (u.startsWith('http://')) return `https://${u.slice(7)}`;
  if (u.startsWith('/')) return `https://www.tikwm.com${u}`;
  return null;
}

/* ---------------------------------------------------------------- download */

async function handleDownload(url, cors) {
  const target = url.searchParams.get('u');
  const name = sanitizeFilename(url.searchParams.get('name') || 'soundseek');

  if (!target || !isAllowedMediaUrl(target)) {
    return json(
      { ok: false, error: 'forbidden_host', message: 'Diese Quelle ist nicht erlaubt.' },
      403,
      cors,
    );
  }

  const upstream = await fetch(target, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; SoundSeek/1.0)',
      referer: 'https://www.tiktok.com/',
    },
  });

  if (!upstream.ok || !upstream.body) {
    return json(
      { ok: false, error: 'upstream_failed', message: 'Die Datei ließ sich nicht laden.' },
      502,
      cors,
    );
  }

  const type = upstream.headers.get('content-type') || 'application/octet-stream';
  const ext = type.includes('mp4') || type.includes('video') ? 'mp4' : 'mp3';

  const headers = new Headers(cors);
  headers.set('content-type', type);
  headers.set('content-disposition', `attachment; filename="${name}.${ext}"`);
  const len = upstream.headers.get('content-length');
  if (len) headers.set('content-length', len);
  headers.set('cache-control', 'no-store');

  return new Response(upstream.body, { status: 200, headers });
}

function isAllowedMediaUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return ALLOWED_MEDIA_HOSTS.some((re) => re.test(u.hostname));
}

function sanitizeFilename(name) {
  return (
    [...name]
      .filter((ch) => ch.codePointAt(0) > 31 && !'\\/:*?"<>|'.includes(ch))
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'soundseek'
  );
}

/* ------------------------------------------------------------------ helper */

function normalizeTikTokUrl(raw) {
  if (typeof raw !== 'string') return null;

  // Aus geteiltem Text den ersten Link herausziehen — die TikTok-App teilt gern
  // "Schau dir das an! https://vm.tiktok.com/xyz/ ..."
  const match = raw.match(/https?:\/\/[^\s]+/);
  const candidate = match ? match[0] : raw.trim();

  let u;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!TIKTOK_HOSTS.some((re) => re.test(u.hostname))) return null;

  u.protocol = 'https:';
  u.hash = '';
  // Tracking-Parameter fliegen raus, der Rest bleibt
  for (const key of [...u.searchParams.keys()]) {
    if (/^(_r|_t|is_from_webapp|sender_device|web_id|share_\w*|utm_\w*|refer|u_code|preview_pb)$/.test(key)) {
      u.searchParams.delete(key);
    }
  }
  return u.toString();
}

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get('origin') || '';
  const allowOrigin = allowed.includes('*')
    ? '*'
    : allowed.includes(origin)
      ? origin
      : allowed[0] || '';

  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function json(payload, status, cors) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
  });
}
