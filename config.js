/**
 * Einzige Datei, die du nach dem Deploy anfassen musst.
 *
 * apiBase = die Adresse deines Cloudflare Workers, ohne Slash am Ende.
 * Wrangler zeigt sie dir am Ende von `npm run deploy` an, z. B.
 *   https://soundseek-api.dein-name.workers.dev
 *
 * Alternativ kannst du die Adresse auch direkt in der App eintragen
 * (Zahnrad oben rechts) — das wird dann im Browser gespeichert.
 */
window.SOUNDSEEK_CONFIG = {
  apiBase: 'https://soundseek-api.12ksnf21.workers.dev',
};
