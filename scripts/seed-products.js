/**
 * Fill the catalogue with a starter set of 30 SAMPLE products (brand "Melody Lab" — placeholders,
 * replace them with your real catalogue in the admin page or via the API).
 *
 *   npm run seed:products            add the samples (skips names that already exist)
 *   npm run seed:products -- --reset delete ALL products first
 */
const mongoose = require('mongoose');
const config = require('../src/config');
const Product = require('../src/models/Product');

const B = 'Melody Lab';
const SAMPLES = [
  // cleansers
  { name: 'Gentle Cream Cleanser', category: 'cleanser', price: 14, size: '150 ml', skinTypes: ['dry', 'sensitive', 'normal'], concerns: ['barrier'], ingredients: ['ceramides', 'glycerin', 'panthenol'], fragranceFree: true, description: 'Low-foam cream cleanser that removes make-up without stripping the skin barrier.' },
  { name: 'Clarifying Gel Cleanser', category: 'cleanser', price: 13, size: '150 ml', skinTypes: ['oily', 'combination'], concerns: ['oil', 'pores'], ingredients: ['salicylic acid 0.5%', 'zinc pca', 'niacinamide'], nonComedogenic: true, description: 'Fresh gel wash that lifts excess oil and keeps pores clear.' },
  { name: 'Calming Milk Cleanser', category: 'cleanser', price: 15, size: '200 ml', skinTypes: ['sensitive', 'dry'], concerns: ['redness'], ingredients: ['centella asiatica', 'allantoin', 'glycerin'], fragranceFree: true, description: 'Soothing milk for reactive skin; rinse-off or tissue-off.' },
  // toners
  { name: 'Pore Refining Toner', category: 'toner', price: 16, size: '120 ml', skinTypes: ['oily', 'combination'], concerns: ['pores', 'oil', 'texture'], ingredients: ['salicylic acid 2%', 'niacinamide'], routine: 'evening', nonComedogenic: true, description: 'Leave-on BHA toner for visibly smaller pores and smoother texture.' },
  { name: 'Hydrating Essence Toner', category: 'toner', price: 15, size: '150 ml', skinTypes: [], concerns: ['dehydration'], ingredients: ['sodium hyaluronate', 'glycerin', 'panthenol'], fragranceFree: true, description: 'Watery first layer that gives an instant moisture boost.' },
  // serums
  { name: 'Hyaluronic Triple Hydration Serum', category: 'serum', price: 22, salePercent: 20, size: '30 ml', skinTypes: [], concerns: ['dehydration', 'barrier'], ingredients: ['hyaluronic acid (3 weights)', 'panthenol', 'ceramides'], fragranceFree: true, badges: ['Bestseller'], rating: 4.7, reviews: 312, description: 'Three molecular weights of hyaluronic acid hydrate surface and deeper layers.' },
  { name: 'Niacinamide 10% + Zinc Serum', category: 'serum', price: 18, size: '30 ml', skinTypes: ['oily', 'combination', 'normal'], concerns: ['pores', 'oil'], ingredients: ['niacinamide 10%', 'zinc pca 1%'], nonComedogenic: true, rating: 4.5, reviews: 540, description: 'Balances sebum and refines the look of pores.' },
  { name: 'Vitamin C 15% Brightening Serum', category: 'serum', price: 28, size: '30 ml', skinTypes: ['normal', 'combination', 'oily', 'dry'], concerns: ['pigmentation'], ingredients: ['ascorbic acid 15%', 'vitamin e', 'ferulic acid'], routine: 'morning', badges: ['New'], description: 'Morning antioxidant serum that fades dark spots and boosts glow.' },
  { name: 'Alpha Arbutin Spot Serum', category: 'serum', price: 19, size: '30 ml', skinTypes: [], concerns: ['pigmentation'], ingredients: ['alpha arbutin 2%', 'tranexamic acid', 'niacinamide'], description: 'Targets dark spots and post-blemish marks.' },
  { name: 'Cica Redness Relief Serum', category: 'serum', price: 21, size: '30 ml', skinTypes: ['sensitive', 'dry', 'normal'], concerns: ['redness', 'barrier'], ingredients: ['centella asiatica', 'madecassoside', 'panthenol'], fragranceFree: true, description: 'Calms visible redness and strengthens reactive skin.' },
  { name: 'Peptide Firming Serum', category: 'serum', price: 32, size: '30 ml', skinTypes: [], concerns: ['wrinkles'], ingredients: ['peptides', 'hyaluronic acid'], description: 'Supports firmness and softens the look of fine lines.' },
  // treatments
  { name: 'Retinol 0.3% Night Treatment', category: 'treatment', price: 29, size: '30 ml', skinTypes: ['normal', 'combination', 'oily', 'dry'], concerns: ['wrinkles', 'texture'], ingredients: ['retinol 0.3%', 'squalane', 'ceramides'], routine: 'evening', description: 'Beginner-friendly retinol for smoother texture and fewer fine lines. Use 2–3 nights a week to start.' },
  { name: 'AHA 7% Resurfacing Solution', category: 'treatment', price: 17, size: '100 ml', skinTypes: ['normal', 'oily', 'combination'], concerns: ['texture', 'pigmentation'], ingredients: ['glycolic acid 7%', 'aloe'], routine: 'evening', description: 'Exfoliating toner-treatment for dull, uneven texture.' },
  { name: 'Azelaic Acid 10% Cream', category: 'treatment', price: 20, size: '30 ml', skinTypes: [], concerns: ['redness', 'pigmentation', 'pores'], ingredients: ['azelaic acid 10%', 'niacinamide'], fragranceFree: true, description: 'Multi-tasker for redness, marks and congestion.' },
  // moisturizers
  { name: 'Barrier Repair Rich Cream', category: 'moisturizer', price: 24, size: '50 ml', skinTypes: ['dry', 'sensitive'], concerns: ['dehydration', 'barrier'], ingredients: ['ceramides', 'squalane', 'hyaluronic acid', 'panthenol'], fragranceFree: true, badges: ['Dermatologist pick'], rating: 4.8, reviews: 221, description: 'Rich cream that restores the lipid barrier and stops moisture loss.' },
  { name: 'Oil-Free Water Gel Moisturizer', category: 'moisturizer', price: 19, size: '50 ml', skinTypes: ['oily', 'combination'], concerns: ['dehydration', 'oil'], ingredients: ['hyaluronic acid', 'niacinamide', 'zinc pca'], nonComedogenic: true, description: 'Weightless gel that hydrates without shine.' },
  { name: 'Daily Balance Lotion', category: 'moisturizer', price: 17, size: '50 ml', skinTypes: ['normal', 'combination'], concerns: ['dehydration'], ingredients: ['glycerin', 'ceramides', 'niacinamide'], nonComedogenic: true, description: 'Light everyday lotion for normal to combination skin.' },
  { name: 'Calm Recovery Balm', category: 'moisturizer', price: 26, size: '40 ml', skinTypes: ['sensitive', 'dry'], concerns: ['redness', 'barrier'], ingredients: ['centella asiatica', 'allantoin', 'ceramides', 'squalane'], fragranceFree: true, routine: 'evening', description: 'Overnight balm for irritated, over-exfoliated skin.' },
  // sunscreens
  { name: 'Invisible Fluid SPF 50', category: 'sunscreen', price: 21, size: '50 ml', skinTypes: [], concerns: ['pigmentation'], ingredients: ['spf 50', 'uv filter', 'niacinamide'], routine: 'morning', nonComedogenic: true, salePercent: 15, rating: 4.6, reviews: 410, description: 'Lightweight daily SPF 50 with no white cast.' },
  { name: 'Mineral Sensitive SPF 50', category: 'sunscreen', price: 23, size: '50 ml', skinTypes: ['sensitive', 'dry'], concerns: ['redness', 'pigmentation'], ingredients: ['zinc oxide', 'titanium dioxide', 'centella asiatica'], routine: 'morning', fragranceFree: true, description: 'Mineral sunscreen for reactive skin.' },
  { name: 'Matte Control SPF 30', category: 'sunscreen', price: 18, size: '50 ml', skinTypes: ['oily', 'combination'], concerns: ['oil'], ingredients: ['spf 30', 'uv filter', 'zinc pca'], routine: 'morning', nonComedogenic: true, description: 'Shine-controlling SPF that doubles as a make-up base.' },
  // masks / eye / body
  { name: 'Purifying Clay Mask', category: 'mask', price: 16, size: '75 ml', skinTypes: ['oily', 'combination'], concerns: ['oil', 'pores'], ingredients: ['kaolin', 'bentonite', 'niacinamide'], routine: 'evening', description: 'Weekly mask that absorbs excess oil from the T-zone.' },
  { name: 'Overnight Hydra Mask', category: 'mask', price: 20, size: '75 ml', skinTypes: ['dry', 'normal'], concerns: ['dehydration'], ingredients: ['hyaluronic acid', 'squalane', 'glycerin'], routine: 'evening', description: 'Sleeping mask for a plump, rested look.' },
  { name: 'Brightening Eye Cream', stock: 0, category: 'eye', price: 22, size: '15 ml', skinTypes: [], concerns: ['wrinkles', 'pigmentation'], ingredients: ['peptides', 'vitamin c', 'caffeine'], description: 'Softens fine lines and dark circles around the eyes.' },
  // other shop groups (not used for face-scan suggestions)
  { name: 'Argan Repair Hair Oil', category: 'hair', price: 18, size: '100 ml', skinTypes: [], concerns: [], ingredients: ['argan oil', 'vitamin e'], description: 'Lightweight oil that tames frizz and adds shine.' },
  { name: 'Gentle Gum Care Toothpaste', category: 'oral', price: 6, size: '75 ml', skinTypes: [], concerns: [], ingredients: ['fluoride', 'aloe'], description: 'Fluoride toothpaste for sensitive gums.' },
  { name: 'Shea Hand & Foot Cream', category: 'hand-foot', price: 11, size: '100 ml', skinTypes: [], concerns: ['dehydration'], ingredients: ['shea butter', 'urea 5%', 'glycerin'], description: 'Rich cream for dry, cracked hands and heels.' },
  { name: 'Natural Fresh Deodorant', category: 'personal', price: 9, size: '50 ml', skinTypes: [], concerns: [], ingredients: ['zinc ricinoleate', 'aloe'], fragranceFree: true, description: 'Aluminium-free deodorant for sensitive skin.' },
  { name: 'Tinted Lip Balm SPF 15', category: 'makeup', price: 8, size: '4 g', skinTypes: [], concerns: [], ingredients: ['shea butter', 'spf 15'], salePercent: 15, description: 'Sheer rosy tint with sun protection.' },
  { name: 'Smoothing Body Lotion', category: 'body', price: 15, size: '250 ml', skinTypes: [], concerns: ['texture', 'dehydration'], ingredients: ['lactic acid', 'ceramides', 'glycerin'], description: 'Exfoliating body lotion for rough, bumpy skin.' },
];

module.exports = { SAMPLES, BRAND: B };

if (require.main === module) (async () => {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
  if (process.argv.includes('--reset')) {
    const { deletedCount } = await Product.deleteMany({});
    console.log(`Deleted ${deletedCount} products.`);
  }
  let added = 0;
  for (const s of SAMPLES) {
    if (await Product.exists({ name: s.name, brand: B })) continue;
    await Product.create({ brand: B, stock: 50, currency: 'USD', ...s });
    added++;
  }
  console.log(`Added ${added} sample products (${SAMPLES.length - added} already existed).`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
