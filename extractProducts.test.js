// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractProducts, extractBalanced } from './extractProducts.js';

const P = (id, price, extra = {}) => ({ productId: id, price, ...extra });
const myx = (products) =>
  `<script>window.__myx={"searchData":{"results":{"products":${JSON.stringify(products)}}}}</script>`;

test('extractBalanced ignores brackets inside strings', () => {
  const s = 'x[{"a":"has ] and [ inside"},{"b":1}]y';
  const out = extractBalanced(s, s.indexOf('['));
  assert.equal(out, '[{"a":"has ] and [ inside"},{"b":1}]');
});

test('valid listing → array of valid products', () => {
  const out = extractProducts(myx([P(111, 9900), P(222, 9200)]));
  assert.equal(out.length, 2);
  assert.equal(out[0].productId, 111);
});

test('maintenance stub / junk → null (not [])', () => {
  assert.equal(extractProducts('<title>Site Maintenance</title>'), null);
  assert.equal(extractProducts('<html>nothing</html>'), null);
  assert.equal(extractProducts(''), null);
  assert.equal(extractProducts(null), null);
});

test('picks the real product array over analytics dataLayer', () => {
  const html =
    '<script>dataLayer={"products":[{"id":"A1","name":"promo"}]}</script>' +
    myx([P(111, 9900), P(222, 9200)]);
  const out = extractProducts(html);
  assert.equal(out.length, 2);
  assert.equal(out[0].productId, 111);
});

test('filters null / invalid entries, no crash', () => {
  const out = extractProducts('<script>x={"products":[null,{"productId":5,"price":100},{"id":"noPrice"}]}</script>');
  assert.equal(out.length, 1);
  assert.equal(out[0].productId, 5);
});

test('entries without productId+price are rejected (analytics-style)', () => {
  // id+name but no productId/price → not a Myntra product → nothing found → null
  assert.equal(extractProducts('<script>x={"products":[{"id":"A","name":"x","quantity":1}]}</script>'), null);
});

test('EMPTY products array is NOT a success — returns null (no false clear)', () => {
  // dataLayer.products:[] must never look like a valid "no deals" scan.
  assert.equal(extractProducts('<script>dataLayer={"products":[]}</script>'), null);
  assert.equal(extractProducts(myx([])), null);
});

test('exact searchData path is preferred over a larger competing array', () => {
  const html =
    '<script>window.__myx={"plaProducts":' +
    JSON.stringify([P(1, 1), P(2, 2), P(3, 3), P(4, 4)]) + // bigger, but wrong
    ',"searchData":{"results":{"products":' +
    JSON.stringify([P(111, 9900)]) + '}}}</script>';
  const out = extractProducts(html);
  assert.equal(out.length, 1);
  assert.equal(out[0].productId, 111); // the real one, not the bigger plaProducts
});
