// Scanner logic tests: coupon matching + URL safety.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, safeMyntraUrl } from './scan.js';

const coin = (over = {}) => ({ productId: 111, price: 9900, product: 'Kalyan 24K 1g', ...over });

test('detects BLINKDEAL in couponData.couponDescription.couponCode', () => {
  const deals = detect([coin({ couponData: { couponDescription: { couponCode: 'BLINKDEAL6', bestPrice: 8900 } } })]);
  assert.equal(deals.length, 1);
  assert.match(deals[0].coupon, /BLINKDEAL6/);
});

test('detects BLINKDEAL in couponData.tagLink', () => {
  const deals = detect([coin({ couponData: { tagLink: 'https://www.myntra.com/myntra?f=Coupons:BLINKDEAL6_1' } })]);
  assert.equal(deals.length, 1);
});

test('does NOT false-positive on a product TITLE containing blinkdeal', () => {
  const deals = detect([coin({ product: 'Special BLINKDEAL Edition Coin', couponData: {} })]);
  assert.equal(deals.length, 0);
});

test('detects a coupon in offerText', () => {
  const deals = detect([coin({ couponData: {}, offerText: 'Apply BLINKDEAL for extra off' })]);
  assert.equal(deals.length, 1);
});

test('no coupon → no deal', () => {
  assert.equal(detect([coin({ couponData: { couponDescription: { couponCode: 'FESTIVE10' } } })]).length, 0);
});

test('products with no id are skipped', () => {
  assert.equal(detect([{ price: 9900, couponData: { tagLink: 'BLINKDEAL' } }]).length, 0);
});

test('safeMyntraUrl: relative path → myntra https', () => {
  assert.equal(safeMyntraUrl('gold-coin/x/111/buy'), 'https://www.myntra.com/gold-coin/x/111/buy');
});

test('safeMyntraUrl: absolute non-myntra host → falls back, never external', () => {
  assert.equal(safeMyntraUrl('http://evil.com/x'), 'https://www.myntra.com/gold-coin');
  assert.equal(safeMyntraUrl('https://evil.com/x'), 'https://www.myntra.com/gold-coin');
});

test('safeMyntraUrl: absolute https myntra host → kept', () => {
  assert.equal(safeMyntraUrl('https://www.myntra.com/gold-coin/x/1/buy'), 'https://www.myntra.com/gold-coin/x/1/buy');
});
