// ============================================================
// CargaYa Demo — backend completo en 1 archivo (Node 18+, sin build)
// v3: sin body en GET (patch global de fetch) + no-store + anti-crash + anti-sleep
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// Quita sslmode de la URL (evita el warning) y configura SSL explícito
const dbUrl = (process.env.DATABASE_URL || '').split('?')[0].split('&')[0];
const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false },
});
pool.on('error', (e) => console.error('[pg pool]', e.message));
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e.message));

const SECRET = process.env.JWT_SECRET || 'devsecret';
const PORT = process.env.PORT || 3000;
const VERSION = 'v3';
const H = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Anti-sleep: mantiene Neon y Render despiertos
const SELF_URL = process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + PORT);
setInterval(async () => { try { await pool.query('SELECT 1'); } catch (e) {} }, 4 * 60 * 1000);
setInterval(async () => { try { await fetch(SELF_URL + '/health'); } catch (e) {} }, 10 * 60 * 1000);

const IDS = {
  client: '11111111-1111-4111-8111-111111111111',
  driver: '22222222-2222-4222-8222-222222222222',
  merchantOwner: '33333333-3333-4333-8333-333333333333',
  admin: '44444444-4444-4444-8444-444444444444',
  address: '12121212-1212-4121-8121-121212121212',
  merchant: '55555555-5555-4555-8555-555555555555',
  productCemento: '77777771-7777-4777-8777-777777777771',
  productCal: '77777772-7777-4777-8777-777777777772',
};
const SEED_STOCK = { [IDS.productCemento]: 100, [IDS.productCal]: 50 };
const COMM_MERCHANT = 0.18, COMM_SHIPPING = 0.20, DRIVER_SHARE = 0.70;
const OFFER_TTL_SEC = 120, MAX_ROUNDS = 3;
const VEHICLES = ['motorcycle', 'car', 'pickup', 'van', 'flatbed'];

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const httpErr = (status, code, message) => Object.assign(new Error(message), { status, code });

function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
const routeKm = (a, b) => round2(haversineKm(a, b) * 1.35);

function auth(...roles) {
  return (req, res, next) => {
    if (req.headers['x-internal-token'] === SECRET) {
      req.user = { sub: 'service', role: 'service' }; return next();
    }
    const t = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token || '';
    try {
      req.user = jwt.verify(t, SECRET);
      if (roles.length && !roles.includes(req.user.role))
        return res.status(403).json({ error: 'FORBIDDEN' });
      next();
    } catch { res.status(401).json({ error: 'UNAUTHORIZED' }); }
  };
}

// ═══════════════ COTIZADOR ═══════════════
function summarizeItems(items) {
  let weight = 0, vol = 0, longest = 0, helpers = 0, forced = -1, hazmat = false;
  for (const it of items) {
    weight += it.quantity * (it.weightKg || 0);
    const v = (it.lengthCm && it.widthCm && it.heightCm)
      ? (it.lengthCm * it.widthCm * it.heightCm) / 1e6 : 0;
    vol += it.quantity * v;
    longest = Math.max(longest,
      it.maxLengthCm || Math.max(it.lengthCm || 0, it.widthCm || 0, it.heightCm || 0));
    helpers = Math.max(helpers, it.helpersRequired || 0);
    if (it.requiresVehicle) forced = Math.max(forced, VEHICLES.indexOf(it.requiresVehicle));
    hazmat = hazmat || !!it.isHazardous;
  }
  return { weight, vol, longest, helpers, forced, hazmat };
}

function priceFor(v, km, weight, vol, helpers) {
  const cw = Math.max(weight, vol * Number(v.vol_factor_kgm3));
  const raw = Number(v.base_fee) + Number(v.per_km) * km + Number(v.per_kg) * cw
            + Number(v.per_m3) * vol + Number(v.per_helper) * helpers;
  const subtotal = Math.max(raw, Number(v.min_fee));
  return {
    chargeable: round2(cw), total: round2(subtotal),
    breakdown: {
      baseFee: Number(v.base_fee), distanceCost: round2(Number(v.per_km) * km),
      weightCost: round2(Number(v.per_kg) * cw), volumeCost: round2(Number(v.per_m3) * vol),
      helpersCost: round2(Number(v.per_helper) * helpers), chargeableWeightKg: round2(cw),
      minFeeApplied: raw < Number(v.min_fee),
    },
  };
}

function planSplit(items, vt) {
  const loads = [];
  for (const it of items) {
    const v = (it.lengthCm && it.widthCm && it.heightCm)
      ? (it.lengthCm * it.widthCm * it.heightCm) / 1e6 : 0;
    const w = it.quantity * (it.weightKg || 0), tv = it.quantity * v;
    if (w <= Number(vt.max_weight_kg) && tv <= Number(vt.max_volume_m3)) {
      loads.push({ name: it.name, w, v }); continue;
    }
    const uw = it.weightKg || 0;
    if (uw <= Number(vt.max_weight_kg) && v <= Number(vt.max_volume_m3)
        && Number.isInteger(it.quantity) && it.quantity <= 200) {
      for (let i = 0; i < it.quantity; i++) loads.push({ name: it.name, w: uw, v });
    } else return null;
  }
  loads.sort((a, b) => b.w - a.w);
  const trips = [];
  let cur = { items: [], weightKg: 0, volumeM3: 0 };
  for (const l of loads) {
    if (cur.items.length && (cur.weightKg + l.w > Number(vt.max_weight_kg)
        || cur.volumeM3 + l.v > Number(vt.max_volume_m3))) {
      trips.push(cur); cur = { items: [], weightKg: 0, volumeM3: 0 };
    }
    cur.items.push(l.name); cur.weightKg += l.w; cur.volumeM3 += l.v;
  }
  if (cur.items.length) trips.push(cur);
  if (!trips.length || trips.length > 6) return null;
  return {
    trips: trips.map((t, i) => ({
      tripNumber: i + 1, items: t.items,
      weightKg: round2(t.weightKg), volumeM3: +t.volumeM3.toFixed(3),
    })),
  };
}

app.post('/api/quotes', auth('client', 'service'), H(async (req, res) => {
  const { origin, dropoff, items } = req.body;
  if (!origin || !dropoff || !Array.isArray(items) || !items.length)
    throw httpErr(400, 'BAD_REQUEST', 'origin, dropoff e items requeridos');

  const km = routeKm(origin, dropoff);
  const cart = summarizeItems(items);
  const vts = (await pool.query('SELECT * FROM vehicle_types ORDER BY id')).rows;
  const viable = vts.filter((v) =>
    Number(v.max_weight_kg) >= cart.weight
    && Number(v.max_volume_m3) >= cart.vol
    && Number(v.max_length_cm) >= cart.longest
    && VEHICLES.indexOf(v.code) >= cart.forced);

  let recommended = null, alternatives = [], split = null;
  if (viable.length) {
    const opts = viable.map((v) => {
      const p = priceFor(v, km, cart.weight, cart.vol, cart.helpers);
      return {
        vehicleTypeId: v.id, code: v.code, vehicleName: v.name, price: p.total,
        etaMinutes: Math.ceil(km / Number(v.avg_speed_kmh) * 60) + 20, breakdown: p.breakdown,
      };
    }).sort((a, b) => a.price - b.price);
    recommended = opts[0]; alternatives = opts.slice(1, 3);
  } else {
    const largest = vts[vts.length - 1];
    const plan = planSplit(items, largest);
    if (!plan) throw httpErr(422, 'NO_VIABLE_VEHICLE', 'Ningún vehículo puede llevar este pedido');
    let total = 0;
    for (const t of plan.trips)
      total += priceFor(largest, km, t.weightKg, t.volumeM3, cart.helpers).total;
    split = {
      vehicleTypeId: largest.id, code: largest.code, vehicleName: largest.name,
      trips: plan.trips, totalPrice: round2(total),
      etaMinutes: Math.ceil((km / Number(largest.avg_speed_kmh) * 60 + 20) * plan.trips.length),
    };
  }

  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60000);
  await pool.query('INSERT INTO quotes (id, data, expires_at) VALUES ($1,$2,$3)',
    [id, JSON.stringify({ origin, dropoff, items, km, cart, recommended, alternatives, split }), expiresAt]);

  res.status(201).json({
    quoteId: id, distanceKm: km,
    cart: { ...cart, itemCount: items.length },
    recommended, alternatives, split,
    warnings: cart.hazmat ? ['HAZMAT_ITEMS_REVIEW_REQUIRED'] : [],
    expiresAt: expiresAt.toISOString(),
  });
}));

// ═══════════════ CHECKOUT ═══════════════
async function orderView(o) {
  const items = (await pool.query(
    `SELECT id, name_snapshot AS name, sku_snapshot AS sku, unit, quantity,
            unit_price AS "unitPrice", subtotal, weight_kg_each AS "weightKgEach"
     FROM order_items WHERE order_id=$1`, [o.id])).rows;
  const { rows: [sh] } = await pool.query(
    'SELECT id, status, driver_id FROM shipments WHERE order_id=$1 ORDER BY trip_number LIMIT 1', [o.id]);
  let driver = null;
  if (sh && sh.driver_id) {
    const d = await pool.query(
      `SELECT u.full_name AS name, v.plate FROM drivers dr
       JOIN users u ON u.id = dr.user_id
       LEFT JOIN vehicles v ON v.driver_id = dr.user_id
       WHERE dr.user_id=$1 LIMIT 1`, [sh.driver_id]);
    driver = d.rows[0] || null;
  }
  return {
    id: o.id, code: o.code, status: o.status, clientName: o.client_name, items,
    subtotal: Number(o.subtotal), shippingTotal: Number(o.shipping_total),
    grandTotal: Number(o.grand_total), currency: o.currency,
    paymentMethod: o.payment_method, placedAt: o.placed_at, dropoff: o.dropoff_address,
    shipment: sh ? { id: sh.id, status: sh.status } : null, driver,
  };
}

app.post('/api/orders', auth('client'), H(async (req, res) => {
  const { quoteId, merchantId, items, dropoffAddressId, paymentMethod = 'cash' } = req.body;

  const q = await pool.query('SELECT data, expires_at FROM quotes WHERE id=$1', [quoteId]);
  if (!q.rows[0]) throw httpErr(404, 'QUOTE_NOT_FOUND', 'Cotización inexistente');
  if (new Date(q.rows[0].expires_at) <= new Date())
    throw httpErr(409, 'QUOTE_EXPIRED', 'La cotización venció. Recotizá el envío.');
  if ((await pool.query('SELECT 1 FROM orders WHERE quote_id=$1', [quoteId])).rows[0])
    throw httpErr(409, 'QUOTE_ALREADY_USED', 'Esta cotización ya fue usada');

  const quote = q.rows[0].data;
  const shipping = quote.split ? quote.split.totalPrice : quote.recommended.price;

  const { rows: [A] } = await pool.query(
    'SELECT * FROM user_addresses WHERE id=$1 AND user_id=$2', [dropoffAddressId, req.user.sub]);
  if (!A) throw httpErr(404, 'ADDRESS_NOT_FOUND', 'Dirección inexistente');

  const c = await pool.connect();
  let order;
  try {
    await c.query('BEGIN');
    const prods = (await c.query(
      'SELECT * FROM products WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [items.map((i) => i.productId)])).rows;
    let subtotal = 0; const lines = [];
    for (const it of items) {
      const p = prods.find((x) => x.id === it.productId);
      if (!p || p.status !== 'active')
        throw httpErr(404, 'PRODUCT_NOT_FOUND', 'Producto inexistente o inactivo');
      if (Number(p.stock) < it.quantity)
        throw httpErr(409, 'INSUFFICIENT_STOCK', 'Stock insuficiente: ' + p.name);
      subtotal += it.quantity * Number(p.base_price);
      lines.push({ p, it });
    }
    subtotal = round2(subtotal);
    const grand = round2(subtotal + shipping);
    const code = 'CY-' + Array.from({ length: 6 }, () =>
      'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

    const o = await c.query(
      `INSERT INTO orders (code, client_id, merchant_id, quote_id, subtotal, shipping_total,
         grand_total, dropoff_address, dropoff_lat, dropoff_lng, payment_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [code, req.user.sub, merchantId, quoteId, subtotal, shipping, grand,
       JSON.stringify({ street: A.street, city: A.city, notes: A.notes }), A.lat, A.lng, paymentMethod]);
    order = o.rows[0];

    for (const l of lines) {
      await c.query(
        `INSERT INTO order_items (order_id, product_id, name_snapshot, sku_snapshot, unit,
           quantity, unit_price, subtotal, weight_kg_each)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [order.id, l.p.id, l.p.name, l.p.sku, l.p.unit, l.it.quantity,
         Number(l.p.base_price), round2(l.it.quantity * Number(l.p.base_price)), Number(l.p.weight_kg)]);
      await c.query('UPDATE products SET stock = stock - $2 WHERE id=$1', [l.p.id, l.it.quantity]);
      await c.query(`INSERT INTO stock_movements (product_id, delta, reason, order_id)
                     VALUES ($1,$2,'order',$3)`, [l.p.id, -l.it.quantity, order.id]);
    }
    await c.query('INSERT INTO payments (order_id, amount, method, provider) VALUES ($1,$2,$3,$4)',
      [order.id, grand, paymentMethod, paymentMethod === 'cash' ? 'cash' : 'mock']);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); c.release(); throw e; }
  c.release();

  res.status(201).json(await orderView(
    (await pool.query('SELECT * FROM orders WHERE id=$1', [order.id])).rows[0]));
}));

// ═══════════════ COMERCIO ═══════════════
app.get('/api/merchant/orders', auth('merchant_admin'), H(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, u.full_name AS client_name FROM orders o
     JOIN users u ON u.id = o.client_id
     WHERE o.merchant_id=$1 AND ($2::text IS NULL OR o.status=$2)
     ORDER BY o.placed_at DESC LIMIT 50`, [req.user.merchantId, req.query.status || null]);
  res.json(await Promise.all(rows.map(orderView)));
}));

async function createOffers(s, round) {
  const ord = (await pool.query('SELECT quote_id FROM orders WHERE id=$1', [s.order_id])).rows[0];
  let cart = { longest: 999, hazmat: false, helpers: 0 };
  if (ord && ord.quote_id) {
    const q = (await pool.query('SELECT data FROM quotes WHERE id=$1', [ord.quote_id])).rows[0];
    if (q) cart = { ...cart, ...q.data.cart };
  }
  const cands = (await pool.query(
    `SELECT d.user_id, d.hazmat_certified, d.lat, d.lng,
            vt.code, vt.max_weight_kg, vt.max_volume_m3, vt.max_length_cm
     FROM drivers d
     JOIN vehicles v ON v.driver_id = d.user_id AND v.is_verified
     JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
     WHERE d.is_online AND d.status='approved'`)).rows;
  const pickup = { lat: Number(s.pickup_lat), lng: Number(s.pickup_lng) };
  const elig = cands
    .filter((c) => c.lat != null
      && VEHICLES.indexOf(c.code) >= VEHICLES.indexOf(s.vehicle_code)
      && Number(c.max_weight_kg) >= Number(s.weight_kg)
      && Number(c.max_volume_m3) >= Number(s.volume_m3)
      && Number(c.max_length_cm) >= (cart.longest || 0)
      && (!cart.hazmat || c.hazmat_certified)
      && haversineKm({ lat: Number(c.lat), lng: Number(c.lng) }, pickup) < 25)
    .sort((a, b) => haversineKm({ lat: Number(a.lat), lng: Number(a.lng) }, pickup)
                  - haversineKm({ lat: Number(b.lat), lng: Number(b.lng) }, pickup))
    .slice(0, 5);

  await pool.query('UPDATE shipments SET rounds=$2 WHERE id=$1', [s.id, round]);
  const payout = round2(Number(s.driver_payout) * (round >= 3 ? 1.25 : 1));
  for (const c of elig)
    await pool.query(
      `INSERT INTO shipment_offers (shipment_id, driver_id, payout, expires_at)
       VALUES ($1,$2,$3, now() + interval '${OFFER_TTL_SEC} seconds')`,
      [s.id, c.user_id, payout]);
  return elig.length;
}

app.post('/api/merchant/orders/:id/accept', auth('merchant_admin'), H(async (req, res) => {
  const created = [];
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [order] } = await c.query(
      `UPDATE orders SET status='accepted', accepted_at=now()
       WHERE id=$1 AND merchant_id=$2 AND status='placed' RETURNING *`,
      [req.params.id, req.user.merchantId]);
    if (!order) throw httpErr(409, 'INVALID_TRANSITION',
      'Ya aceptado/rechazado o no es tu comercio');

    const { rows: [m] } = await c.query('SELECT * FROM merchants WHERE id=$1', [order.merchant_id]);
    const { rows: [q] } = await c.query('SELECT data FROM quotes WHERE id=$1', [order.quote_id]);
    const quote = q ? q.data : null;

    const vtId = quote ? (quote.split ? quote.split.vehicleTypeId : quote.recommended.vehicleTypeId) : 4;
    const vCode = quote ? (quote.split ? quote.split.code : quote.recommended.code) : 'van';
    const trips = quote && quote.split
      ? quote.split.trips
      : [{ tripNumber: 1, weightKg: quote ? quote.cart.weight : 0, volumeM3: quote ? quote.cart.vol : 0 }];
    const perTripShip = round2(Number(order.shipping_total) / trips.length);

    for (const t of trips) {
      const { rows: [sh] } = await c.query(
        `INSERT INTO shipments (order_id, trip_number, vehicle_type_id, vehicle_code,
           pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, distance_km, weight_kg, volume_m3,
           helpers_count, driver_payout, cod_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [order.id, t.tripNumber, vtId, vCode,
         m.lat, m.lng, order.dropoff_lat, order.dropoff_lng,
         quote ? quote.km : 0, t.weightKg, t.volumeM3, quote ? quote.cart.helpers : 0,
         round2(perTripShip * DRIVER_SHARE),
         order.payment_method === 'cash' ? round2(Number(order.grand_total) / trips.length) : 0]);
      created.push(sh);
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); c.release(); throw e; }
  c.release();

  for (const s of created) await createOffers(s, 1);
  await pool.query(`INSERT INTO admin_audit_log (actor, action, detail) VALUES ($1,'order.accept',$2)`,
    [req.user.sub, JSON.stringify({ orderId: req.params.id, shipments: created.map((s) => s.id) })]);
  res.json({ ok: true, shipments: created.map((s) => s.id) });
}));

app.post('/api/merchant/orders/:id/ready', auth('merchant_admin'), H(async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE orders SET status='ready'
     WHERE id=$1 AND merchant_id=$2 AND status IN ('accepted','preparing')`,
    [req.params.id, req.user.merchantId]);
  if (!rowCount) throw httpErr(409, 'INVALID_TRANSITION', 'No se puede marcar listo');
  res.json({ ok: true });
}));

// ═══════════════ CONDUCTOR ═══════════════
app.get('/api/driver/offers', auth('driver'), H(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.id, o.shipment_id, o.payout, o.expires_at,
            s.weight_kg, s.volume_m3, s.helpers_count, s.distance_km,
            ord.code AS order_code, m.name AS merchant_name, m.address_text AS pickup_address
     FROM shipment_offers o
     JOIN shipments s ON s.id = o.shipment_id
     JOIN orders ord ON ord.id = s.order_id
     JOIN merchants m ON m.id = ord.merchant_id
     WHERE o.driver_id=$1 AND o.status='pending' AND o.expires_at > now()
     ORDER BY o.offered_at DESC`, [req.user.sub]);
  res.json(rows.map((r) => ({
    ...r, payout: Number(r.payout),
    weight_kg: Number(r.weight_kg), volume_m3: Number(r.volume_m3),
    distance_km: Number(r.distance_km),
  })));
}));

app.post('/api/driver/offers/:id/accept', auth('driver'), H(async (req, res) => {
  const { rows: [off] } = await pool.query(
    `UPDATE shipment_offers SET status='accepted'
     WHERE id=$1 AND driver_id=$2 AND status='pending' AND expires_at > now() RETURNING *`,
    [req.params.id, req.user.sub]);
  if (!off) throw httpErr(409, 'OFFER_NOT_AVAILABLE', 'Venció o la tomó otro flete');

  const busy = await pool.query(
    `SELECT 1 FROM shipments WHERE driver_id=$1
     AND status IN ('accepted','en_route_pickup','at_pickup','loaded','in_transit','at_dropoff')`,
    [req.user.sub]);
  if (busy.rows[0]) {
    await pool.query(`UPDATE shipment_offers SET status='pending' WHERE id=$1`, [off.id]);
    throw httpErr(409, 'DRIVER_BUSY', 'Ya tenés un viaje activo');
  }
  const { rowCount } = await pool.query(
    `UPDATE shipments SET driver_id=$2, status='accepted', assigned_at=now()
     WHERE id=$1 AND status='unassigned'`, [off.shipment_id, req.user.sub]);
  if (!rowCount) {
    await pool.query(`UPDATE shipment_offers SET status='pending' WHERE id=$1`, [off.id]);
    throw httpErr(409, 'OFFER_NOT_AVAILABLE', 'El envío ya no está disponible');
  }
  await pool.query(
    `UPDATE shipment_offers SET status='lost'
     WHERE shipment_id=$1 AND status='pending'`, [off.shipment_id]);
  res.json({ shipmentId: off.shipment_id, payout: Number(off.payout) });
}));

app.get('/api/driver/shipment', auth('driver'), H(async (req, res) => {
  const { rows: [s] } = await pool.query(
    `SELECT * FROM shipments WHERE driver_id=$1
     AND status IN ('accepted','en_route_pickup','at_pickup','loaded','in_transit','at_dropoff')
     ORDER BY created_at DESC LIMIT 1`, [req.user.sub]);
  if (!s) return res.json(null);
  const proofs = (await pool.query(
    'SELECT stage, geo_verified AS "geoVerified" FROM shipment_proofs WHERE shipment_id=$1',
    [s.id])).rows;
  res.json({
    id: s.id, orderId: s.order_id, status: s.status,
    weightKg: Number(s.weight_kg), volumeM3: Number(s.volume_m3), helpersCount: s.helpers_count,
    driverPayout: Number(s.driver_payout), codAmount: Number(s.cod_amount),
    pickup: { lat: Number(s.pickup_lat), lng: Number(s.pickup_lng) },
    dropoff: { lat: Number(s.dropoff_lat), lng: Number(s.dropoff_lng) },
    proofs,
  });
}));

app.post('/api/driver/shipments/:id/proofs', auth('driver'), H(async (req, res) => {
  const { rows: [s] } = await pool.query('SELECT * FROM shipments WHERE id=$1', [req.params.id]);
  if (!s || s.driver_id !== req.user.sub) throw httpErr(403, 'NOT_SHIPMENT_DRIVER');
  const { stage, lat, lng } = req.body;
  if (!['pickup', 'loaded', 'delivery', 'damage'].includes(stage)) throw httpErr(400, 'BAD_STAGE');
  const dPick = haversineKm({ lat, lng }, { lat: Number(s.pickup_lat), lng: Number(s.pickup_lng) }) * 1000;
  const dDrop = haversineKm({ lat, lng }, { lat: Number(s.dropoff_lat), lng: Number(s.dropoff_lng) }) * 1000;
  const nearest = Math.min(dPick, dDrop);
  if (nearest > 200)
    throw httpErr(422, 'PROOF_GEO_FAIL', 'Foto a ' + Math.round(nearest) + ' m del punto (máx 200 m)');
  await pool.query(
    `INSERT INTO shipment_proofs (shipment_id, stage, image_url, lat, lng, geo_verified)
     VALUES ($1,$2,$3,$4,$5,true)`,
    [s.id, stage, req.body.imageUrl || ('demo://' + s.id + '/' + stage + '.jpg'), lat, lng]);
  res.status(201).json({ stage, geoVerified: true });
}));

async function finalize(shipmentId) {
  const s = (await pool.query('SELECT * FROM shipments WHERE id=$1', [shipmentId])).rows[0];
  const { rows: [o] } = await pool.query(
    `UPDATE orders SET status='delivered', delivered_at=now(), payment_status='captured'
     WHERE id=$1 AND status <> 'delivered' RETURNING *`, [s.order_id]);
  if (!o) return;

  const mComm = round2(Number(o.subtotal) * COMM_MERCHANT);
  const sComm = round2(Number(o.shipping_total) * COMM_SHIPPING);
  const entries = [
    ['merchant', o.merchant_id, 'sale', Number(o.subtotal)],
    ['merchant', o.merchant_id, 'commission', -mComm],
    ['driver', s.driver_id, 'driver_payout', Number(s.driver_payout)],
    ['platform', 'PLATFORM', 'commission', mComm + sComm],
  ];
  if (o.payment_method === 'cash')
    entries.push(['driver', s.driver_id, 'cod_collected', -Number(o.grand_total)]);

  for (const [at, aid, et, amt] of entries)
    await pool.query(
      `INSERT INTO ledger_entries (account_type, account_id, entry_type, amount, order_id, description)
       VALUES ($1,$2,$3,$4,$5,$6)`, [at, aid, et, amt, o.id, et]);
}

app.post('/api/driver/shipments/:id/status', auth('driver'), H(async (req, res) => {
  const { rows: [s] } = await pool.query('SELECT * FROM shipments WHERE id=$1', [req.params.id]);
  if (!s) throw httpErr(404, 'NOT_FOUND');
  if (s.driver_id !== req.user.sub) throw httpErr(403, 'NOT_SHIPMENT_DRIVER');

  const from = s.status, to = req.body.status;
  const allowed = {
    accepted: ['en_route_pickup'], en_route_pickup: ['at_pickup'],
    at_pickup: ['loaded'], loaded: ['in_transit'],
    in_transit: ['at_dropoff'], at_dropoff: ['delivered'],
  };
  if (!allowed[from] || !allowed[from].includes(to))
    throw httpErr(409, 'INVALID_TRANSITION', from + ' → ' + to + ' no permitido');

  if (to === 'loaded' && !(await pool.query(
      `SELECT 1 FROM shipment_proofs
       WHERE shipment_id=$1 AND stage IN ('pickup','loaded') AND geo_verified LIMIT 1`,
      [s.id])).rows[0])
    throw httpErr(422, 'PROOF_REQUIRED', 'Sacá la foto de carga (geo-verificada) primero');
  if (to === 'delivered' && !(await pool.query(
      `SELECT 1 FROM shipment_proofs
       WHERE shipment_id=$1 AND stage='delivery' AND geo_verified LIMIT 1`,
      [s.id])).rows[0])
    throw httpErr(422, 'PROOF_REQUIRED', 'Sacá la foto de entrega (geo-verificada) primero');

  await pool.query(
    `UPDATE shipments SET status=$2,
            delivered_at = CASE WHEN $2='delivered' THEN now() ELSE delivered_at END
     WHERE id=$1`, [s.id, to]);
  await pool.query(`INSERT INTO admin_audit_log (actor, action, detail) VALUES ($1,'shipment.status',$2)`,
    [req.user.sub, JSON.stringify({ shipmentId: s.id, from, to })]);
  if (to === 'delivered') await finalize(s.id);
  res.json({ status: to });
}));

// ═══════════════ BÚSQUEDA REPUESTOS ═══════════════
app.get('/api/parts/search', H(async (req, res) => {
  const norm = (req.query.oem || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (!norm && !req.query.make) throw httpErr(400, 'BAD_REQUEST', 'pasá oem o make');
  const { rows } = await pool.query(
    `SELECT DISTINCT p.id, p.name, p.sku, p.base_price AS price, b.name AS brand,
            m.name AS merchant, o.code AS oem, vm.name AS model, vk.name AS make
     FROM products p
     JOIN merchants m ON m.id = p.merchant_id AND m.vertical='auto_parts' AND m.status='active'
     LEFT JOIN brands b ON b.id = p.brand_id
     LEFT JOIN product_compatibility pc ON pc.product_id = p.id
     LEFT JOIN vehicle_models vm ON vm.id = pc.model_id
     LEFT JOIN vehicle_makes vk ON vk.id = vm.make_id
     LEFT JOIN product_oem_codes o ON o.product_id = p.id
     WHERE p.status='active'
       AND ($1='' OR o.code=$1)
       AND ($2='' OR vk.slug=$2)
       AND ($3='' OR vm.slug=$3)
       AND ($4=0 OR ((pc.year_from IS NULL OR pc.year_from<=$4)
                 AND (pc.year_to IS NULL OR pc.year_to>=$4)))
     LIMIT 20`, [norm, req.query.make || '', req.query.model || '', Number(req.query.year) || 0]);
  res.json({ items: rows });
}));

// ═══════════════ ADMIN ═══════════════
app.get('/api/admin/dashboard', auth('superadmin'), H(async (_q, res) => {
  const { rows: [k] } = await pool.query(`SELECT
    (SELECT count(*) FROM orders)::int AS orders,
    (SELECT count(*) FROM orders WHERE status='delivered')::int AS delivered,
    (SELECT COALESCE(SUM(grand_total),0) FROM orders WHERE status='delivered') AS gmv,
    (SELECT count(*) FROM shipments WHERE status='unassigned')::int AS unassigned,
    (SELECT count(*) FROM drivers WHERE is_online)::int AS drivers_online,
    (SELECT COALESCE(SUM(amount),0) FROM ledger_entries WHERE account_type='platform') AS platform_revenue`);
  res.json(k);
}));

app.get('/api/admin/ledger', auth('superadmin'), H(async (_q, res) => {
  const { rows } = await pool.query(
    `SELECT account_type, entry_type, amount, order_id, description, created_at
     FROM ledger_entries ORDER BY created_at DESC LIMIT 50`);
  res.json(rows);
}));

// ═══════════════ SWEEPER ═══════════════
async function restock(orderId, reason) {
  const items = (await pool.query(
    'SELECT product_id, quantity FROM order_items WHERE order_id=$1', [orderId])).rows;
  for (const it of items) {
    await pool.query('UPDATE products SET stock = stock + $2 WHERE id=$1', [it.product_id, it.quantity]);
    await pool.query(`INSERT INTO stock_movements (product_id, delta, reason, order_id)
                      VALUES ($1,$2,$3,$4)`, [it.product_id, it.quantity, reason, orderId]);
  }
}

setInterval(async () => {
  try {
    await pool.query(`UPDATE shipment_offers SET status='expired'
                      WHERE status='pending' AND expires_at <= now()`);
    const { rows: due } = await pool.query(
      `SELECT * FROM shipments WHERE status='unassigned' AND rounds < $1
       AND NOT EXISTS (SELECT 1 FROM shipment_offers o
                       WHERE o.shipment_id = shipments.id AND o.status='pending')
       AND EXISTS (SELECT 1 FROM shipment_offers o
                   WHERE o.shipment_id = shipments.id AND o.status='expired')`, [MAX_ROUNDS]);
    for (const s of due) await createOffers(s, s.rounds + 1);
    const { rows: stale } = await pool.query(
      `UPDATE orders SET status='rejected', cancellation_reason='sla_expired'
       WHERE id IN (SELECT id FROM orders WHERE status='placed'
                    AND placed_at < now() - interval '10 minutes' LIMIT 20) RETURNING id`);
    for (const o of stale) await restock(o.id, 'sla_expired');
  } catch (e) { console.error('[sweeper]', e.message); }
}, 5000);

// ═══════════════ DEV helpers ═══════════════
app.get('/health', H(async (_q, res) => {
  let db = 'ok', error = null;
  try { await pool.query('SELECT 1'); } catch (e) { db = 'fail'; error = e.message; }
  res.json({ ok: true, v: VERSION, db, error });
}));

app.get('/dev/tokens', (_q, res) => {
  const mk = (sub, role, extra = {}) =>
    jwt.sign({ sub, role, ...extra }, SECRET, { expiresIn: '12h' });
  res.json({
    client: mk(IDS.client, 'client'),
    driver: mk(IDS.driver, 'driver'),
    merchant: mk(IDS.merchantOwner, 'merchant_admin', { merchantId: IDS.merchant }),
    admin: mk(IDS.admin, 'superadmin'),
  });
});

app.get('/api/demo/config', (_q, res) => res.json({
  merchantId: IDS.merchant, addressId: IDS.address,
  merchant: { lat: -34.5780, lng: -58.4450 },
  dropoff: { lat: -34.6037, lng: -58.3816 },
  products: [
    { id: IDS.productCemento, name: 'Cemento portland 50kg' },
    { id: IDS.productCal, name: 'Cal 25kg' },
  ],
}));

app.post('/api/dev/reset', H(async (_q, res) => {
  await pool.query(`TRUNCATE quotes, orders, order_items, payments, shipments,
                    shipment_offers, shipment_proofs, ledger_entries, stock_movements, admin_audit_log`);
  for (const [pid, stock] of Object.entries(SEED_STOCK))
    await pool.query('UPDATE products SET stock=$2 WHERE id=$1', [pid, stock]);
  res.json({ ok: true });
}));

// ═══ PÁGINA: se sirve desde demo.html (archivo aparte — el backend ya no la contiene) ═══
const fs = require('fs');
app.get('/', (_q, res) => {
  res.set('Cache-Control', 'no-store');
  let html;
  try { html = fs.readFileSync(__dirname + '/demo.html', 'utf8'); }
  catch { html = '<h2 style="font-family:system-ui;padding:24px">Falta demo.html en el repo (Add file → demo.html).</h2>'; }
  res.type('html').send(html);
});

// 404 + errores
app.use('/api', (req, res) => res.status(404).json({ error: 'NOT_FOUND', path: req.originalUrl }));
app.use((err, _q, res, _n) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err.message);
  res.status(status).json({ error: err.code || 'INTERNAL_ERROR', message: err.message });
});

app.listen(PORT, () => console.log('🚀 CargaYa demo v4 en puerto ' + PORT));
