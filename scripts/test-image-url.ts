/** Offline test for app/lib/image-url.ts. Run: `npx tsx scripts/test-image-url.ts`. */
import assert from 'node:assert/strict';
import { normalizeImageUrl, isGooglePhotosLink } from '../app/lib/image-url';

const T = 'https://drive.google.com/thumbnail?id=ABC_123-x&sz=w1000';
const id = 'ABC_123-x';

assert.equal(normalizeImageUrl(`https://drive.google.com/file/d/${id}/view?usp=sharing`), T);
assert.equal(normalizeImageUrl(`https://drive.google.com/file/d/${id}/preview`), T);
assert.equal(normalizeImageUrl(`https://drive.google.com/open?id=${id}`), T);
assert.equal(normalizeImageUrl(`https://drive.google.com/uc?id=${id}&export=view`), T);
assert.equal(normalizeImageUrl(`https://docs.google.com/uc?id=${id}`), T);
assert.equal(normalizeImageUrl(`  https://drive.google.com/file/d/${id}/view  `), T);

// Pass-through
assert.equal(normalizeImageUrl(T), T);
assert.equal(normalizeImageUrl('https://lh3.googleusercontent.com/d/abc=w1000'), 'https://lh3.googleusercontent.com/d/abc=w1000');
assert.equal(normalizeImageUrl('  https://example.com/a.jpg '), 'https://example.com/a.jpg');

// Google Photos
assert.equal(normalizeImageUrl('https://photos.app.goo.gl/AbCdEf'), null);
assert.equal(normalizeImageUrl('https://photos.google.com/share/AF1Q?key=x'), null);
assert.equal(isGooglePhotosLink('https://photos.app.goo.gl/AbCdEf'), true);
assert.equal(isGooglePhotosLink('https://photos.google.com/share/AF1Q?key=x'), true);
assert.equal(isGooglePhotosLink('https://example.com/a.jpg'), false);
assert.equal(isGooglePhotosLink('nonsense'), false);

// Invalid
assert.equal(normalizeImageUrl(''), null);
assert.equal(normalizeImageUrl('   '), null);
assert.equal(normalizeImageUrl('http://example.com/a.jpg'), null);
assert.equal(normalizeImageUrl('javascript:alert(1)'), null);
assert.equal(normalizeImageUrl('not a url'), null);
assert.equal(normalizeImageUrl('https://drive.google.com/drive/folders/xyz'), null);

console.log('image-url: all assertions passed');
