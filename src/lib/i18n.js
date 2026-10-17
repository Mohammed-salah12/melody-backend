/**
 * Arabic responses: when the app sends `Accept-Language: ar`, text in JSON responses (analysis
 * wording, alerts, routines, error messages, chat system notes) is translated on the way out.
 * Exact strings come from a dictionary; sentences with numbers/names use {0} patterns.
 * Identifiers (ids, keys, types, statuses…) and people's own text are never touched.
 */
const { exact, patterns } = require('./i18n-ar');

// fields that hold ids, codes, names or user-written text
const SKIP_KEYS = new Set([
  'id', '_id', 'key', 'keys', 'name', 'fullName', 'brand', 'phone', 'email', 'url', 'imageUrl', 'token', 'icon', 'slug',
  'type', 'status', 'kind', 'from', 'category', 'skinTypes', 'specialties', 'consultTypes', 'focus', 'step', 'mode', 'tone',
  'action', 'source', 'mime', 'fileName', 'reportCode', 'currency', 'code', 'ingredients', 'description', 'summary', 'note',
  'bio', 'about', 'title_en', 'authorName', 'address', 'street', 'city', 'state', 'zip', 'country', 'room', 'productName',
]);

const compiled = Object.entries(patterns)
  .sort(([a], [b]) => b.length - a.length)
  .map(([en, ar]) => {
    const rx = new RegExp('^' + en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{(\d+)\\\}/g, '(.+?)') + '$', 's');
    const order = [...en.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]));
    // text between consecutive placeholders ('' = glued together, ' ' = one space)
    const seps = order.slice(1).map((n, i) => en.slice(en.indexOf(`{${order[i]}}`) + `{${order[i]}}`.length, en.indexOf(`{${n}}`)));
    return { rx, ar, order, seps };
  });

const known = (s) => /^[\d.,%\s+-]*$/.test(s) || !!exact[s] || !!exact[s.charAt(0).toUpperCase() + s.slice(1)];
const tr1 = (s) => {
  const hit = exact[s] ?? exact[s.charAt(0).toUpperCase() + s.slice(1)];
  if (hit) return hit;
  // lists such as "redness and dark spots" / "a, b and c"
  const parts = s.split(/, | and /);
  if (parts.length > 1 && parts.every(known)) return parts.map((x) => tr1(x)).join(' و');
  return translate(s, true);
};

/** Translates one string (exact match first, then sentence patterns). */
function translate(s, inner = false) {
  if (typeof s !== 'string' || !s) return s;
  // standalone single lowercase words are usually identifiers ('video', 'dryness') — only inside sentences
  if (exact[s] && (inner || /[A-Z\s]/.test(s))) return exact[s];
  for (const p of compiled) {
    const m = s.match(p.rx);
    if (!m) continue;
    const vals = m.slice(1);
    const outVals = vals.map((v) => v);
    for (let i = 0; i < vals.length; i++) {
      const sep = p.seps[i];
      if (sep === '' && i + 1 < vals.length) {
        // glued placeholders (e.g. lower-cased first letter + rest) → translate as one phrase
        outVals[i] = tr1(vals[i] + vals[i + 1]);
        outVals[i + 1] = '';
        i++;
        continue;
      }
      if (sep === ' ' && i + 1 < vals.length && !(known(vals[i]) && known(vals[i + 1]))) {
        // two phrases separated by a space: find the split where both parts are known
        const all = `${vals[i]} ${vals[i + 1]}`;
        const words = all.split(' ');
        for (let k = 1; k < words.length; k++) {
          const a = words.slice(0, k).join(' '), b = words.slice(k).join(' ');
          if (known(a) && known(b)) {
            outVals[i] = tr1(a);
            outVals[i + 1] = tr1(b);
            break;
          }
        }
        if (outVals[i] === vals[i]) outVals[i] = tr1(vals[i]);
        if (outVals[i + 1] === vals[i + 1]) outVals[i + 1] = tr1(vals[i + 1]);
        i++;
        continue;
      }
      outVals[i] = tr1(vals[i]);
    }
    let out = p.ar;
    p.order.forEach((n, i) => {
      out = out.replace(`{${n}}`, outVals[i]);
    });
    return out;
  }
  return s;
}

// labels that are meant for display even when they are a single lowercase word
const LABEL_KEYS = new Set(['focusLabel', 'label', 'needLabel', 'agent', 'caption']);

function walk(v, key, parent) {
  if (typeof v === 'string') {
    if (SKIP_KEYS.has(key)) return v;
    if (LABEL_KEYS.has(key)) return translate(v, true);
    // chat messages written by people stay as written
    if (key === 'text' && parent && (parent.from === 'patient' || parent.from === 'doctor')) return v;
    return translate(v);
  }
  if (Array.isArray(v)) return v.map((x) => walk(x, key, parent));
  if (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    if (typeof v.toJSON === 'function') v = v.toJSON();
    if (!v || typeof v !== 'object') return v;
    const out = Array.isArray(v) ? [] : {};
    for (const [k, x] of Object.entries(v)) out[k] = SKIP_KEYS.has(k) && typeof x !== 'object' ? x : walk(x, k, v);
    return out;
  }
  return v;
}

const wantsArabic = (req) => /^ar\b/i.test(String(req.headers['accept-language'] ?? '')) || req.query?.lang === 'ar';

/** Express middleware: wraps res.json for Arabic requests. */
function arabicResponses(req, res, next) {
  if (!wantsArabic(req)) return next();
  const json = res.json.bind(res);
  res.json = (body) => {
    try {
      return json(walk(body));
    } catch {
      return json(body); // never break a response because of translation
    }
  };
  next();
}

module.exports = { arabicResponses, translate, wantsArabic };
