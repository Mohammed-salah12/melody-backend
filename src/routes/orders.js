/**
 * Orders. Prices always come from the database (the app's prices are never trusted), stock is
 * reserved when the order is placed.
 *
 * Payment: there is no real payment provider yet.
 *  - card: in PAYMENT_MODE=test (development) the order is accepted as paid without charging
 *    anything; in live mode card orders are refused until a provider (e.g. Stripe) is connected.
 *    Only brand + last 4 digits + expiry ever reach the server — never the full number or CVV.
 *  - bank: the order waits for a bank transfer (status "awaiting_payment").
 */
const { Router } = require('express');
const { isValidObjectId } = require('mongoose');

const config = require('../config');
const Order = require('../models/Order');
const Product = require('../models/Product');
const { HttpError } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { cleanAddress } = require('./account');

const router = Router();

/** GET /orders/config — public shop settings for the checkout screens. */
router.get('/config', (_req, res) => {
  const s = config.shop;
  res.json({
    currency: s.currency,
    shippingFee: s.shippingFee,
    freeShippingOver: s.freeShippingOver,
    paymentMode: s.paymentMode,
    bank: s.bank,
    supportEmail: s.supportEmail,
    deliveryDays: s.deliveryDays,
  });
});

router.use(requireAuth);

const shippingFor = (subtotal) => {
  const s = config.shop;
  return s.freeShippingOver > 0 && subtotal >= s.freeShippingOver ? 0 : s.shippingFee;
};
const round2 = (v) => Math.round(v * 100) / 100;

async function newNumber() {
  for (let digits = 4; digits <= 8; digits++) {
    for (let i = 0; i < 5; i++) {
      const n = `MB-${Math.floor(10 ** (digits - 1) + Math.random() * 9 * 10 ** (digits - 1))}`;
      if (!(await Order.exists({ number: n }))) return n;
    }
  }
  throw new HttpError(500, 'Could not create an order number.');
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/**
 * POST /orders
 * { items: [{ productId, qty }], addressId? | address?, saveAddress?, payment: { method: 'card'|'bank',
 *   card?: { brand, last4, expMonth, expYear, holder, save? } } }
 */
router.post('/', async (req, res) => {
  const user = req.user;
  const body = req.body ?? {};

  // items
  const lines = Array.isArray(body.items) ? body.items : [];
  if (!lines.length || lines.length > 50) throw new HttpError(400, 'Your cart is empty.');
  const qtyById = new Map();
  for (const l of lines) {
    if (!isValidObjectId(l?.productId)) throw new HttpError(400, 'One of the products is not available any more.');
    const q = Math.floor(Number(l.qty));
    if (!(q >= 1 && q <= 20)) throw new HttpError(400, 'Quantity must be between 1 and 20.');
    qtyById.set(String(l.productId), (qtyById.get(String(l.productId)) ?? 0) + q);
    if (qtyById.get(String(l.productId)) > 20) throw new HttpError(400, 'You can order up to 20 of each product.');
  }
  const products = await Product.find({ _id: { $in: [...qtyById.keys()] }, active: true });
  if (products.length !== qtyById.size) throw new HttpError(409, 'Some products in your cart are not available any more. Please review your cart.');
  for (const p of products) {
    if (p.stock < qtyById.get(p.id)) throw new HttpError(409, p.stock > 0 ? `Only ${p.stock} × ${p.name} left in stock.` : `${p.name} is sold out.`);
  }

  // address
  let address;
  if (body.addressId) {
    const a = user.addresses.id(body.addressId);
    if (!a) throw new HttpError(400, 'Please choose a shipping address.');
    address = a.toObject();
    delete address._id;
    delete address.isDefault;
  } else if (body.address) {
    address = cleanAddress(body.address);
    if (body.saveAddress && user.addresses.length < 10) {
      user.addresses.push({ ...address, isDefault: !user.addresses.length || !!body.address.isDefault });
      if (body.address.isDefault) for (const a of user.addresses) a.isDefault = a === user.addresses[user.addresses.length - 1];
    }
  } else throw new HttpError(400, 'Please add a shipping address.');

  // payment
  const method = body.payment?.method;
  const payment = { method, status: 'pending', provider: 'none' };
  if (method === 'card') {
    const c = body.payment.card ?? {};
    if (!/^\d{4}$/.test(String(c.last4 ?? ''))) throw new HttpError(400, 'Please enter your card details.');
    const m = Number(c.expMonth);
    const y = Number(c.expYear) < 100 ? 2000 + Number(c.expYear) : Number(c.expYear);
    const now = new Date();
    if (!(m >= 1 && m <= 12) || y < now.getFullYear() || (y === now.getFullYear() && m < now.getMonth() + 1)) throw new HttpError(400, 'This card has expired.');
    if (config.shop.paymentMode !== 'test') {
      throw new HttpError(503, 'Card payments are not available yet. Please choose bank transfer.');
    }
    Object.assign(payment, { brand: String(c.brand || 'card'), last4: String(c.last4), status: 'paid', provider: 'test' });
    if (c.save && !user.cards.some((x) => x.last4 === payment.last4 && x.brand === payment.brand) && user.cards.length < 10) {
      user.cards.push({ brand: payment.brand, last4: payment.last4, expMonth: m, expYear: y, holder: String(c.holder || '').slice(0, 80) });
    }
  } else if (method !== 'bank') {
    throw new HttpError(400, 'Please choose a payment method.');
  }

  // reserve stock (conditional update so two orders can't take the last item)
  const taken = [];
  for (const p of products) {
    const q = qtyById.get(p.id);
    const r = await Product.updateOne({ _id: p._id, stock: { $gte: q } }, { $inc: { stock: -q } });
    if (!r.modifiedCount) {
      for (const t of taken) await Product.updateOne({ _id: t.id }, { $inc: { stock: t.q } });
      throw new HttpError(409, `${p.name} just sold out. Please review your cart.`);
    }
    taken.push({ id: p._id, q });
  }

  const items = products.map((p) => ({
    product: p._id,
    name: p.name,
    brand: p.brand,
    size: p.size,
    category: p.category,
    unitPrice: Product.finalPrice(p),
    regularPrice: p.price,
    qty: qtyById.get(p.id),
    hasImage: p.hasImage,
    imageUrl: p.imageUrl,
  }));
  const subtotal = round2(items.reduce((s, i) => s + i.unitPrice * i.qty, 0));
  const shipping = shippingFor(subtotal);
  try {
    const order = await Order.create({
      user: user._id,
      number: await newNumber(),
      items,
      currency: config.shop.currency,
      subtotal,
      shipping,
      total: round2(subtotal + shipping),
      address,
      payment,
      status: payment.status === 'paid' ? 'confirmed' : 'awaiting_payment',
      estimatedDelivery: addDays(new Date(), config.shop.deliveryDays),
    });
    await user.save();
    res.status(201).json({ ...order.toPublic(), bank: method === 'bank' ? config.shop.bank : undefined });
  } catch (e) {
    for (const t of taken) await Product.updateOne({ _id: t.id }, { $inc: { stock: t.q } });
    throw e;
  }
});

/** GET /orders — my orders, newest first. */
router.get('/', async (req, res) => {
  const orders = await Order.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(50);
  res.json({ items: orders.map((o) => o.toPublic()) });
});

/** GET /orders/:id (or by number, e.g. MB-8829) */
router.get('/:id', async (req, res) => {
  const q = isValidObjectId(req.params.id) ? { _id: req.params.id } : { number: req.params.id };
  const order = await Order.findOne({ ...q, user: req.user._id });
  if (!order) throw new HttpError(404, 'Order not found.');
  res.json(order.toPublic());
});

module.exports = router;
