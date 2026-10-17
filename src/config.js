require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name} in .env — copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

module.exports = {
  port: Number(process.env.PORT) || 4000,
  mongoUri: required('MONGODB_URI'),
  jwtSecret: required('JWT_SECRET'),
  isProd: process.env.NODE_ENV === 'production',
  tokenTtl: '30d',
  otpTtlMinutes: 10,
  // Temporary: every verification code is this value until an SMS provider is connected.
  // Ignored in production. Remove FIXED_OTP from .env to go back to random codes.
  shop: {
    currency: 'USD',
    shippingFee: Number(process.env.SHIPPING_FEE ?? 12),
    freeShippingOver: Number(process.env.FREE_SHIPPING_OVER || 0), // 0 = never free
    deliveryDays: Number(process.env.DELIVERY_DAYS || 5),
    // 'test' accepts card orders without charging (development only). 'live' needs a real
    // payment provider (not connected yet), so card orders are refused until one is added.
    paymentMode: process.env.NODE_ENV === 'production' ? 'live' : process.env.PAYMENT_MODE === 'live' ? 'live' : 'test',
    bank: {
      name: process.env.BANK_NAME || 'Bank of Palestine',
      accountName: process.env.BANK_ACCOUNT_NAME || 'Melody Beauty',
      iban: process.env.BANK_IBAN || '',
    },
    supportEmail: process.env.SUPPORT_EMAIL || 'support@melody.beauty',
  },
  clinic: {
    timezone: process.env.CLINIC_TIMEZONE || 'Asia/Gaza',
    timezoneLabel: process.env.CLINIC_TIMEZONE_LABEL || 'PALESTINE TIME',
    slotMinutes: Number(process.env.CONSULT_MINUTES || 45),
    freeConsultations: Number(process.env.FREE_CONSULTATIONS ?? 5),
    bookingDaysAhead: Number(process.env.BOOKING_DAYS_AHEAD || 30),
    cancellationHours: Number(process.env.CANCELLATION_HOURS || 12),
  },
  // video calls (https://livekit.io — cloud or self-hosted); empty = video calls switched off
  livekit: {
    url: (process.env.LIVEKIT_URL || '').trim(),
    apiKey: (process.env.LIVEKIT_API_KEY || '').trim(),
    apiSecret: (process.env.LIVEKIT_API_SECRET || '').trim(),
  },
  fixedOtp: process.env.NODE_ENV === 'production' ? null : (process.env.FIXED_OTP || '').trim() || null,
};
