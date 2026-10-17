/** Error with an HTTP status; the error handler turns it into { message }. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Pick trimmed strings from a body and fail with 400 if any required one is missing. */
function need(body, ...fields) {
  const out = {};
  for (const f of fields) {
    const v = typeof body?.[f] === 'string' ? body[f].trim() : body?.[f];
    if (v === undefined || v === null || v === '') throw new HttpError(400, `Please provide ${f}.`);
    out[f] = v;
  }
  return out;
}

module.exports = { HttpError, need };
