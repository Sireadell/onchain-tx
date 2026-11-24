import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkShopifyStock, readAsk, findStore } from './shopifyStock.js';
import { checkAppleStore, readAppleProduct } from './appleStore.js';

const NOW = new Date('2026-11-24T00:00:00Z');

test('reads product, size and gender from a stock question', () => {
  const q = "Is the Allbirds Men's Wool Runners in Natural Grey, size 10, available for purchase on allbirds.com right now?";
  const a = readAsk(q, findStore(q));
  assert.equal(a.product, "Men's Wool Runners");
  assert.equal(a.size, '10');
  assert.equal(a.gender, 'men');
});

test('reads one size from the Shopify product feed', async () => {
  const fetchJson = async (u) => (u.includes('suggest')
    ? { resources: { results: { products: [{ title: "Men's Wool Runner - Natural Grey", handle: 'mens-wool-runners', available: true, price: '110.00' }] } } }
    : { title: "Men's Wool Runner - Natural Grey", available: true, options: [{ name: 'Size' }], variants: [{ options: ['10'], available: false, price: 11000 }, { options: ['11'], available: true, price: 11000 }] });
  const r = await checkShopifyStock("Is the Men's Wool Runners shoe in size 10 available on Allbirds.com?", { fetchJson, now: NOW });
  assert.equal(r.verdict, 'Out of stock');
  assert.deepEqual(r.available_sizes, ['11']);
});

test('says not found when the store lists no such product', async () => {
  const fetchJson = async () => ({ resources: { results: { products: [{ title: "Men's Wool Runner NZ", handle: 'nz', available: true }] } } });
  const r = await checkShopifyStock('Is the "Men\'s Wool Runner Mizzle" available in size 11 at Allbirds?', { fetchJson, now: NOW });
  assert.equal(r.verdict, 'Not found');
});

test('reads Apple models and chips', () => {
  assert.deepEqual(readAppleProduct('Apple iPhone 14 Pro Max 256GB'), { kind: 'iphone', slug: 'iphone-14-pro', name: 'iPhone 14 Pro Max' });
  assert.equal(readAppleProduct('Apple MacBook Pro 16-inch M3 Pro').chip, 'M3 Pro');
});

test('an iPhone not on the apple.com store page is discontinued there', async () => {
  const fetchText = async () => '<a href="/shop/buy-iphone/iphone-17">x</a><a href="/shop/buy-iphone/iphone-16">y</a>';
  const gone = await checkAppleStore('How many units of the Apple iPhone 14 Pro Max are on apple.com?', { fetchText, now: NOW });
  assert.equal(gone.verdict, 'Discontinued');
  assert.match(gone.answer, /does not publish unit counts/);
  const sold = await checkAppleStore('Is the Apple iPhone 16 available on apple.com?', { fetchText, now: NOW });
  assert.equal(sold.verdict, 'In stock');
});
