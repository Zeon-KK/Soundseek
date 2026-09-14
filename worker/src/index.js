/**
 * SoundSeek API — Cloudflare Worker
 *
 * Zwei Endpunkte:
 *   POST /api/identify  { url }   -> erkennt den Song hinter einem TikTok-Link
 *   GET  /api/download?u=&name=   -> reicht TikTok-Medien mit Download-Header durch
 *
 * Der AudD-Token liegt als Secret im Worker und verlässt ihn nie.
 */

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
      if (url.pathname === '/api/health') {
        return json({ ok: true, configured: Boolean(env.AUDD_API_TOKEN) }, 200, cors);
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

  // Beides parallel: AudD erkennt den Song, tikwm liefert Cover, Video und Sound.
  const [recognition, media] = await Promise.all([
    recognize(tiktokUrl, env),
    fetchMedia(tiktokUrl).catch(() => null),
  ]);

  if (!recognition.ok) {
    return json({ ...recognition, media }, recognition.status || 502, cors);
  }

  return json({ ok: true, song: recognition.song, media, source: tiktokUrl }, 200, cors);
}

async function recognize(tiktokUrl, env) {
  const params = new URLSearchParams({
    api_token: env.AUDD_API_TOKEN,
    url: tiktokUrl,
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
    // 900 = Token wird nicht akzeptiert, 901 = Kontingent aufgebraucht
    const message =
      code === 901
        ? 'Das AudD-Kontingent ist aufgebraucht.'
        : code === 900
          ? 'Der AudD-Token wird nicht akzeptiert.'
          : (data.error && data.error.error_message) || 'AudD meldet einen Fehler.';
    return { ok: false, error: 'audd_error', code, message, status: 502 };
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
