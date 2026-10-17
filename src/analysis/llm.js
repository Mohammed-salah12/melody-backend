/**
 * Optional: let an LLM (Claude) rewrite the "why this product" text in a warmer, personal way.
 * Only active when ANTHROPIC_API_KEY is set in .env. It never changes which products are
 * chosen or their match %, and if it fails or is slow the template text is used.
 */
const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.AI_MODEL || 'claude-sonnet-4-5';

async function personaliseReasons(items, context) {
  if (!KEY || !items.length) return null;
  const prompt = `You write short product explanations for a skincare app.
Skin scan: ${JSON.stringify(context)}.
For each product write ONE sentence (max 28 words) explaining why it fits this person, using the measured numbers.
Don't claim to cure or diagnose anything. Reply with JSON only: {"<productId>": "<sentence>", ...}
Products: ${JSON.stringify(items.map((i) => ({ productId: i.productId, name: i.name, category: i.category, ingredients: i.ingredients, reasons: i.reasons })))}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.content?.find((c) => c.type === 'text')?.text ?? '';
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    return JSON.parse(json);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { personaliseReasons, llmEnabled: Boolean(KEY) };
