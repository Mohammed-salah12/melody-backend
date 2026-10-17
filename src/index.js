const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const mongoose = require('mongoose');

const config = require('./config');

/** wss://x.livekit.cloud → the websocket + https origins the browser needs */
function livekitOrigins(url) {
  if (!url) return [];
  try {
    const u = new URL(url);
    const host = u.host;
    const secure = u.protocol === 'wss:' || u.protocol === 'https:';
    return [`${secure ? 'wss' : 'ws'}://${host}`, `${secure ? 'https' : 'http'}://${host}`];
  } catch {
    return [];
  }
}

const app = express();
app.set('trust proxy', 1);
app.use(
  helmet({
    // allow product photos from other sites (imageUrl) in the admin page
    // + the video server (LiveKit) for the doctor's call page
    contentSecurityPolicy: {
      directives: {
        'img-src': ["'self'", 'data:', 'blob:', 'https:'],
        'media-src': ["'self'", 'blob:'],
        'connect-src': ["'self'", ...livekitOrigins(config.livekit.url)],
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // the app loads /products/:id/image
  }),
);
app.use(cors());
app.use(express.json({ limit: '12mb' })); // camera frames arrive as base64 JPEG
app.use(require('./lib/i18n').arabicResponses); // Accept-Language: ar → Arabic text in responses

// the LiveKit browser library for the doctor's call page (served from our own origin)
const LIVEKIT_UMD = require('path').join(__dirname, '..', 'node_modules', 'livekit-client', 'dist', 'livekit-client.umd.js');
app.get('/vendor/livekit-client.umd.js', (_req, res) => res.type('application/javascript').sendFile(LIVEKIT_UMD));
app.use('/admin', express.static(require('path').join(__dirname, '..', 'public', 'admin')));
app.get('/health', (_req, res) =>
  res.json({ ok: true, db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' }),
);
app.use('/auth', require('./routes/auth'));
app.use('/scans', require('./routes/scans'));
app.use('/skin', require('./routes/skin'));
app.use('/products', require('./routes/products'));
app.use('/recommendations', require('./routes/recommendations'));
app.use('/alerts', require('./routes/alerts'));
app.use('/routine', require('./routes/routine'));
app.use('/account', require('./routes/account'));
app.use('/training', require('./routes/training'));
app.use('/orders', require('./routes/orders'));
app.use('/doctors', require('./routes/doctors'));
app.use('/appointments', require('./routes/appointments'));

app.use((_req, res) => res.status(404).json({ message: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ message: 'That image is too large.' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ message: status >= 500 ? 'Something went wrong on our side. Please try again.' : err.message });
});

async function start() {
  try {
    await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
    console.log('MongoDB connected');
  } catch (e) {
    console.error('\nCould not connect to MongoDB:', e.message);
    console.error('Check MONGODB_URI in .env and that your IP is allowed in Atlas → Network Access.\n');
    process.exit(1);
  }
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`Melody Beauty API listening on http://0.0.0.0:${config.port}`);
  });
}

if (require.main === module) start();

module.exports = { app, start };
