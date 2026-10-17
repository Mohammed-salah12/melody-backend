# Melody Beauty — API (Node.js · Express · MongoDB Atlas)

Backend for the Melody Beauty app: accounts, phone codes, live skin scans and the Skin Passport.

## Run it

```bash
cd backend
npm install
npm run dev        # restarts on file changes   (or: npm start)
```

It listens on port **4000**. Check it at http://localhost:4000/health → `{"ok":true,"db":"connected"}`.

Settings live in `.env` (never commit it — it holds the database password):

| key | what |
| --- | --- |
| `MONGODB_URI` | Atlas connection string (database `melody-beauty`) |
| `JWT_SECRET` | random string used to sign login tokens |
| `PORT` | default 4000 |
| `NODE_ENV` | `development` returns SMS codes in the response as `devCode`; set `production` to stop that |

**Atlas → Network Access** must allow the IP of the machine running this server, or the connection times out.

### Phone codes

There is no SMS provider yet. Codes are printed in the server terminal (`[otp] verify code for … : 12345`).
Plug a provider into `issueOtp()` in `src/lib/tokens.js`.

## Endpoints

All bodies are JSON. Authenticated routes need `Authorization: Bearer <token>`.

| | |
| --- | --- |
| `POST /auth/register` | `{ fullName, phone, password, email?, birthDate?, address?, gender?, maritalStatus?, skinCondition?, medications?, productAllergy?, ingredientAllergy?, acceptedTerms }` → texts a code |
| `POST /auth/verify-phone` | `{ phone, code }` → `{ token, user }` |
| `POST /auth/login` | `{ phone, password }` → `{ token, user }` |
| `POST /auth/forgot-password` | `{ phone }` → texts a code |
| `POST /auth/verify-reset-code` | `{ phone, code }` → `{ resetToken }` |
| `POST /auth/reset-password` | `{ resetToken, password }` |
| `GET /auth/me` | current user |
| `POST /scans` | start a scan → `{ scanId, plan }` |
| `POST /scans/:id/frames` | `{ image: <base64 JPEG>, pose: "front" \| "up" }` → live feedback `{ accepted, tip, quality, metrics, running, progress }` |
| `POST /scans/:id/complete` | → `{ results: { score, metrics, skinType, concerns, recommendations } }` |
| `GET /scans` · `GET /scans/:id` · `GET /scans/:id/photo` | history, one scan, saved face photo |
| `GET /skin/snapshot` | "Today's Skin Snapshot" (score, streak, stats, 7-day trend) |
| `GET /skin/passport` | profile + full scan history |

## The skin analyzer (`src/analysis/`)

`skin-analyzer.js` measures each camera frame:

* **Quality** — face found, light (too dark / harsh), distance (too far / close), centred, holding still. This drives the tips in the app.
* **Metrics (0–100)** — hydration (estimate), oil/shine, redness, pigmentation (dark spots), texture, pores, fine lines, tone evenness — computed from colour (CIE Lab) and detail statistics in face zones (T-zone, cheeks, forehead, eye area).

**Pores (`pores.js`)** are counted for real on the cheeks at full camera resolution: find the eye line, take the cheek patch under each eye, convert to mm using an average face width of 14 cm, subtract the local average brightness (~1.2 mm window) so only small dark dips remain, ignore fold/shadow edges, then keep dark spots 0.1–1.1 mm across that are roughly round. Output: count, pores per cm², average size, and a 0–100 score. It needs ≤ 0.25 mm per pixel (face ~600 px wide in the photo); otherwise the app asks the user to come closer and the texture-based estimate is used. On synthetic tests it finds ~75–80 % of pores at normal density (fewer when pores touch).

`results.js` combines the frames (median) into a skin score, skin type, concerns and simple product recommendations, and builds the snapshot from the scan history.

This is a measurable computer-vision baseline, **not a medical diagnosis and not a trained model**. The calibration numbers are first guesses: collect real scans (with dermatologist labels), tune them, and later swap in a trained model behind the same `analyzeFrame()` function. pH, true moisture and sebum need the future Smart Skin Pen (`source: "smart-pen"` is reserved on scans).

Try it on photos: `npm run test:analyzer -- face1.jpg face2.jpg`

## Products & suggested treatment

### Setup

```bash
npm run seed:products               # add 25 SAMPLE products (brand "Melody Lab" — placeholders)
npm run seed:products -- --reset    # delete all products first
npm run make-admin -- +970599123456 # give an account admin rights (sign up in the app first)
```

Then open **http://localhost:4000/admin** and log in with that account. There you can add, edit, hide, delete and upload photos for products.

### Products API

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/products` | anyone | list · `?q=&category=&brand=&skinType=&concern=&minPrice=&maxPrice=&inStock=true&sort=price\|-price\|rating\|-rating\|newest\|name&page=&limit=` |
| GET | `/products/meta` | anyone | allowed categories, skin types, concerns |
| GET | `/products/:id` | anyone | one product |
| GET | `/products/:id/image` | anyone | uploaded photo |
| POST | `/products` | admin | create |
| POST | `/products/bulk` | admin | `{ products: [...] }` (up to 500) |
| PUT / PATCH | `/products/:id` | admin | replace / update |
| PATCH | `/products/:id/stock` | admin | `{ stock: 10 }` or `{ change: -2 }` |
| DELETE | `/products/:id` | admin | hide (add `?hard=true` to delete for good) |
| PUT / DELETE | `/products/:id/image` | admin | upload (`{ image: "data:image/jpeg;base64,…" }`, max 3 MB) / remove photo |

What the matcher reads from each product: `category`, `skinTypes` (empty = all), `concerns`, `ingredients`, `routine` (morning / evening / both), `fragranceFree`, `nonComedogenic`.

### Recommendations — `GET /recommendations?scanId=&limit=8` (logged in)

Matches the latest (or given) scan against every active product (`src/analysis/matcher.js`):

1. **Skin needs** from the scan: e.g. hydration 48 → strong dehydration need; redness 58 → redness need.
2. **What each product treats**: its declared concerns + what its ingredients are known to do (`src/analysis/ingredients.js`, e.g. hyaluronic acid → hydration, niacinamide → pores/oil, retinol → lines/texture).
3. **Score** = how well it covers your biggest needs × skin-type fit × safety. Products with an ingredient you said you're allergic to are left out (`excluded`), harsh actives are penalised for sensitive skin.
4. **Routine**: best cleanser → serum → moisturizer → SPF for the morning, cleanser → treatment → moisturizer for the evening, never mixing actives that clash (e.g. retinol + acids).

Returns `{ focus, focusLabel, focusValue, skinType, items: [{ match, why, reasons, warnings, product }], routine: { morning, evening }, excluded, explainedBy }`.

**AI wording (optional):** set `ANTHROPIC_API_KEY` (and optionally `AI_MODEL`) in `.env` and Claude rewrites the "Why this product" text for the top 3 in friendlier words. The ranking always comes from the matcher, so it stays explainable and works without the key.

`GET /skin/snapshot?index=1` returns the scan before the latest (the arrows on the Analysis card); 404 when there are no older scans.

## Skin Profile — `GET /skin/profile` (logged in)

Everything the Skin Profile tab shows, computed from the user's scans (`src/analysis/profile.js`):

- **patient**: name, age (from birth date), address, skin type, **T-zone** and **cheeks** labels (each frame now measures shine on the T-zone and on the cheeks separately, plus cheek hydration — older scans fall back to the whole-face values), and **today's weather** for the address.
- **week**: Mon–Sun of this week with that day's latest scan score (Weekly Vitality).
- **glow**: latest score, change vs last week, 7-day trend bars, historical high.
- **analysis**: 7 cards (sensitivity, moisture, oil control, pores, pigmentation, roughness, wrinkles) with value, status word and advice.
- **risk**: past / current / potential conditions from the scan history (e.g. "Transepidermal Water Loss" when hydration is low) and a report id. These are camera estimates, not a diagnosis — the response includes that note.

**Weather** comes from Open-Meteo (free, no key): the address is geocoded (e.g. "Gaza | Deir al Balah" → Deir al Balah), then current temperature, humidity and UV are fetched and cached for 30 minutes. If the server has no internet it simply returns `weather: null`. Set `WEATHER=off` in `.env` to disable it.

## Skin alerts — `GET /alerts?spfAt=<ISO>` (logged in)

Pop-up alerts in the app (the bell in the header lists them). Each one is only raised from real data (`src/analysis/alerts.js`):

| Alert | Raised when | Data source |
|---|---|---|
| Stressed skin | latest scan (last 36 h) is clearly worse than the user's own baseline (earlier scans): hydration −5 % or more, redness +15 %, or score −6 % | scans |
| SPF | UV index ≥ 3 in daylight and no sunscreen logged today, or the logged one is ~2 h old (protection estimate = 100 − 40 %/hour) | Open-Meteo UV + `spfAt` sent by the app ("I've just applied it") |
| Pollution | US AQI ≥ 101 | Open-Meteo air quality |
| Pollen | pollen ≥ 50 grains/m³ (only modelled for Europe) | Open-Meteo air quality |
| Poor sleep | under 6 h sleep logged for last night | `POST /alerts/sleep { hours }` |

`POST /alerts/sleep { hours, date?, source? }` stores last night's sleep (for a later Apple Health / Health Connect link).
Alerts need the user's address for weather/air; without it only the scan and sleep alerts can appear.

## Longevity tab data (inside `GET /skin/profile`)

- **longevity** `{ chronoAge, bioAge, delta, score, note }` — biological skin age: the median of the last 3 scans' fine lines, dark spots, texture, tone evenness and hydration compared with what is typical for the user's age (from date of birth). Each sign adds or removes a little "apparent age" (±10 years max). An estimate from visible signs, not a medical test. `bioAge` is null when the date of birth is missing.
- **pathology** `[{ key, title, active, text }]` — camera-sign screening for acne-prone congestion (pores + oil + redness), rosacea (redness high in most recent scans), hyperpigmentation and trans-epidermal water loss. Active items first. Not a diagnosis.

## Shop filters (app "Filter By" screen)

`GET /products` also accepts:
- `group=face,body,hair,oral,makeup,hand-foot,personal` — "Our available items" (each group maps to categories; see `GROUPS` in `src/models/Product.js`). New categories: `hair`, `oral`, `hand-foot`, `personal`.
- `concern=acne,dryness,redness,pigmentation` — "What problem are you experiencing?" (`acne` also matches products made for pores/oil, `dryness` matches dehydration/barrier). New product concern: `acne`.
- `onSale=true` — products with a badge like "15% off"; `inStock=true` — hides sold-out items.

The sample catalogue now has 30 products (incl. hair, oral, hand & foot, personal care, makeup, and one sold-out item). Run `npm run seed:products -- --reset` to reload it.

## Product page data

- `GET /products/:id` now also returns `insights` (`src/analysis/insights.js`): `keyIngredients` (up to 3 actives, in the product's own ingredient order, for the side pill), `benefits` ("Clinical profile", from the product's concerns + ingredient knowledge base), `usage` ("Usage protocol", 3 steps for its category) and `routineLabel`.
- `GET /recommendations/product/:id` (logged in) — how that product matches the user's latest scan: `match` (compatibility index), `highlights` (the user's measured values it targets), `alignment` (analysis need → active ingredient → Exact / High / Moderate) and `excluded` when it contains an ingredient the user is allergic to. `{ applicable: false }` for non-face products; 404 without a scan.

## Offers (sale prices)

Products have `salePercent` (0–90). The API returns `finalPrice` (= price − salePercent) next to the regular `price`; the app shows "15% OFFER", the sale price in red and the regular price crossed out, and the cart charges the sale price. Set it in the admin page ("Sale %") or with `PATCH /products/:id { "salePercent": 15 }`; `0` ends the offer. `?onSale=true` lists products on offer. (Older "15% off" badges still count as an offer.)

## Checkout & orders

| Method | Path | What |
|---|---|---|
| GET | `/orders/config` | shipping fee, free-shipping threshold, payment mode, bank details, support email |
| GET/POST | `/account/addresses` | saved shipping addresses (`fullName, street, suite?, city, state?, zip?, country?, phone?, isDefault?`) |
| PUT/DELETE | `/account/addresses/:id` | edit / remove |
| GET / DELETE | `/account/cards`, `/account/cards/:id` | saved cards — **display info only** (brand, last 4, expiry, holder) |
| POST | `/orders` | `{ items: [{ productId, qty }], addressId \| address, saveAddress?, payment: { method: 'card', card: { brand, last4, expMonth, expYear, holder, save? } } \| { method: 'bank' } }` |
| GET | `/orders`, `/orders/:id` | my orders (by id or number, e.g. `MB-8829`) |

How an order is made: prices come from the database (offer prices included — what the app sends is ignored), max 20 per product, stock is reserved with a conditional update so two people can't buy the last item, shipping = `SHIPPING_FEE` (free above `FREE_SHIPPING_OVER` if set), estimated delivery = today + `DELIVERY_DAYS`, order number `MB-xxxx`.

**Payments — important:** no real payment provider is connected yet.
- The app checks the card (Luhn, expiry, CVV) on the phone and sends **only** brand, last 4 digits and expiry — the full number and CVV never reach the server or the database.
- `PAYMENT_MODE=test` (default outside production): card orders are accepted as *paid* without charging anything — for testing the flow only.
- In production (or `PAYMENT_MODE=live`) card orders are refused with a clear message until a provider such as Stripe is integrated (that needs a development build of the app, not Expo Go).
- Bank transfer works now: the order is created with status `awaiting_payment` and the app shows the bank name/IBAN (`BANK_*` in `.env`).

## Doctors, booking & Clinical Archive

Setup: `npm run seed:doctors` (5 SAMPLE doctors — placeholder names; replace them) and manage everything at **http://localhost:4000/admin/clinic.html** (admin login): add/edit doctors, working days & hours, specialties, video/chat, photo, "Break 30m", hide; see consultations, mark no-show, and **Complete** with a clinical summary + protocol — that is what appears in the patient's Clinical Archive and PDF.

| Method | Path | What |
|---|---|---|
| GET | `/doctors?q=&specialty=acne,eczema&type=video,chat&availableNow=true` | list with live `availability` |
| GET | `/doctors/:id`, `/doctors/:id/image`, `/doctors/meta` | details, photo, specialties/time zone |
| GET | `/doctors/:id/slots?date=YYYY-MM-DD` | that day's slots (`available`, `reason`: past/booked/break) |
| POST/DELETE | `/doctors/:id/watch` | "Notify me when available" → a skin alert when the doctor is online |
| POST/PATCH/DELETE | `/doctors`, `/doctors/:id`, `/doctors/:id/break`, `PUT /doctors/:id/image` | admin |
| GET | `/appointments/summary` | free consultations used / total, upcoming |
| POST | `/appointments` | `{ doctorId, date, time: "10:00", type: video\|chat, problem? }` |
| GET | `/appointments?when=upcoming\|past`, `/appointments/archive` | mine; archive = completed with summary |
| POST | `/appointments/:id/cancel` | up to `CANCELLATION_HOURS` before |
| GET | `/appointments/:id/report-link` → `/appointments/:id/report.pdf?t=…` | PDF report (10-minute signed link) |
| GET/POST | `/appointments/admin/all`, `/appointments/:id/complete`, `/appointments/:id/no-show` | admin |
| POST | `/appointments/instant` | `{ doctorId }` — "Chat now" with an online doctor → status `requested`; becomes `missed` if not accepted in 3 min |
| GET | `/appointments/:id` | one of mine (status, `acceptedAt`, `chatOpen`) |
| GET/POST | `/appointments/:id/messages?after=ISO` / `{ text }` | chat messages (patient sends; open while the chat is live) |
| GET | `/appointments/admin/chats` | admin: waiting requests + live/near-time chats |
| POST | `/appointments/:id/accept`, `/:id/staff-message`, `/:id/end-chat` | admin/doctor side of the chat |
| POST | `/appointments/:id/files` | `{ kind: image\|audio\|file, data: "data:<mime>;base64,…", name?, durationSec? }` — photo, voice note or PDF/image/text file (max 8 MB) |
| GET | `/appointments/:id/files/:fid?t=…` | the attachment (signed link, sent with each message, valid 12 h) |
| POST | `/appointments/:id/typing`, `/:id/staff-typing` | "typing…" (shown for 6 s) |
| POST | `/appointments/:id/request-report` (admin) → `/:id/report-access { approve }` (patient) | doctor asks to see the last 7 days of skin scans + sleep logs; patient approves or declines |
| GET | `/appointments/:id/patient-report` | admin, only after approval, for 24 hours |
| POST | `/appointments/:id/finish` | patient ends the chat ("End Session") → can then rate the doctor |
| GET | `/appointments/:id/call` (patient) · `/:id/staff-call` (doctor) | LiveKit `{ url, token, room }` for video consultations (open 10 min before → 30 min after; 503 until LIVEKIT_* is set) |
| GET | `/appointments/:id/staff` · `/:id/staff-suggestions` | doctor console: the consultation; products ranked for the shared scan (match %) |
| POST | `/appointments/:id/staff-files` · `/:id/staff-product { productId }` · `/:id/staff-report { note }` | doctor sends a photo/voice note/file, a "Suggested Treatment" card, or a skin-report PDF (`/:id/messages/:mid/report.pdf?t=…`) |
| GET | `/doctors/:id/reviews?page=` | public patient reviews (newest first) |
| GET/POST | `/doctors/:id/review-eligibility`, `/doctors/:id/reviews` `{ rating 1–5, text }` | only after a **completed** consultation or an **ended chat**, one review each; the doctor's rating/review count is recomputed from reviews |
| PATCH | `/doctors/reviews/:rid` `{ hidden }` | admin moderation |

**Availability** is computed from real data (`src/analysis/availability.js`): outside working hours → offline; in a booked consultation → busy ("available in X min" when ≤ 15 min left); break set by the clinic → on break until HH:MM; otherwise online ("Fast-Track" when there's still a free slot today). Slots are hourly, `CONSULT_MINUTES` long, in `CLINIC_TIMEZONE`, bookable `BOOKING_DAYS_AHEAD` days ahead and not less than 30 minutes before. Double bookings are refused (also for the patient). The first `FREE_CONSULTATIONS` bookings are marked free. The patient's latest scan is linked to the booking and included in the PDF.

**Doctor console** — `/admin/consult.html?id=…`, opened from **Live consultations** on the clinic page (Accept / Open chat / Open call). It has the chat (photos, voice notes, files, patient "typing…"), a side rail with **Skin report** (request access, see the shared scans, send a report PDF) and **Clinical protocol** (products ranked for the patient's scan, SEND as a "Suggested Treatment" card), and the **video call** for video consultations.

**Video calls (LiveKit)**: create a free project at https://cloud.livekit.io (or self-host), then add to `.env`:
`LIVEKIT_URL=wss://<project>.livekit.cloud`, `LIVEKIT_API_KEY=…`, `LIVEKIT_API_SECRET=…` and restart. The app needs a development build for calls (`npx expo run:ios` / `run:android` or EAS) — Expo Go has no WebRTC; it shows "open chat instead".

**Chat**: instant chat requests wait 3 minutes for a doctor to Accept; scheduled consultations open 10 minutes before. End chat / End consultation closes it, then **Complete** with a summary as usual. Messages are polled every 3 s (no websockets yet). Ratings come only from real reviews.

Not built yet: push notifications (so the patient/doctor isn't alerted when the other joins unless the app/page is open).

## Product matching & the skin model

**Matching** (`src/analysis/matcher.js`, `ingredients.js`, `outcomes.js`) works for every product you add, automatically:
- Paste the product's **full ingredient list** (or key actives, with % when known) in the admin page — about 60 actives are recognised by their INCI names, weighted by position in the list and by %.
- Personal safety from the user's health answers: pregnancy / breastfeeding (retinoids, hydroquinone hidden; salicylic acid with a warning), isotretinoin / prescription retinoids (exfoliants & retinoids hidden), allergies, sensitive skin (irritating actives and fragrance ranked lower), comedogenic oils for oily skin.
- Concerns that got worse since the previous scan get more weight.
- **Evidence**: when ≥ 3 buyers of a product rescanned 2–17 weeks later, products whose buyers improved more than average get up to +10% (or −10%). Recomputed hourly.
- The product form shows a live **“How the app will match this product”** preview (`POST /products/analyze`) with recognised actives, what it treats, safety notes and suggested tags.

**Skin model**: opt-in photos (`PUT /account/training-consent`), doctor grading at `/admin/grading.html` (`/training/*`), `npm run export:dataset`, `ml/train.py`. See `ml/README.md`.
