'use strict';

const TRANSPORTS = ['pixel', 'screenshot'];
const DEFAULT_TRANSPORT = 'screenshot';
function transportName(v) {
  const t = String(v || DEFAULT_TRANSPORT).toLowerCase();
  return TRANSPORTS.includes(t) ? t : '';
}

function chooseTransport(capture, state) {
  const explicit = capture && capture.mode !== undefined && capture.mode !== null && capture.mode !== '';
  if (explicit) return { transport: transportName(capture.mode), source: 'config', fallback: null };
  const fb = state && state.transportFallback && typeof state.transportFallback === 'object' ? state.transportFallback : null;
  if (fb && FALLBACK_REASONS[fb.reason]) return { transport: 'pixel', source: 'fallback', fallback: fb };
  return { transport: DEFAULT_TRANSPORT, source: 'default', fallback: null };
}

const FALLBACK_REASONS = {
  missing: 'the game client has no Screenshot() function',
  failed: 'the game client reported SCREENSHOT_FAILED on every try',
};
function transportFallback(state, reason, job, now = Date.now()) {
  if (!FALLBACK_REASONS[reason]) return null;
  const cur = state.transportFallback;
  if (cur && cur.reason === reason) return null;
  state.transportFallback = { reason, at: now, session: (job && job.session) || '' };
  return transportNote(state.transportFallback);
}
function transportNote(fb) {
  if (!fb || !FALLBACK_REASONS[fb.reason]) return '';
  const when = fb.at ? new Date(fb.at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'an earlier run';
  return (
    `pixel transport, fallen back to since ${when} because ${FALLBACK_REASONS[fb.reason]}; ` +
    'the pixel capture is deprecated: set capture.mode in config.json to "pixel" to keep it without this note, or to "screenshot" to try the screenshot transport again'
  );
}

const DEFAULT_LEVELS = { off: 0, on: 60 };
function screenshotLevels(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  let off = Number.isInteger(r.off) ? r.off : DEFAULT_LEVELS.off;
  let on = Number.isInteger(r.on) ? r.on : DEFAULT_LEVELS.on;
  if (off < 0 || off > 255 || on < 0 || on > 255 || on - off < 8) ({ off, on } = DEFAULT_LEVELS);
  return { off, on, threshold: Math.floor((off + on) / 2) + 1 };
}

const STRIP_CODECS = [1, 2];
const DEFAULT_STRIP_CODEC = 2;
function stripCodec(raw) {
  return STRIP_CODECS.includes(raw) ? raw : DEFAULT_STRIP_CODEC;
}

function denseLevels(raw) {
  const lv = screenshotLevels(raw);
  return [0, 1, 2, 3].map(k => Math.floor(lv.off + (k * (lv.on - lv.off)) / 3 + 0.5));
}

module.exports = {
  TRANSPORTS,
  DEFAULT_TRANSPORT,
  transportName,
  chooseTransport,
  FALLBACK_REASONS,
  transportFallback,
  transportNote,
  DEFAULT_LEVELS,
  screenshotLevels,
  STRIP_CODECS,
  DEFAULT_STRIP_CODEC,
  stripCodec,
  denseLevels,
};
