import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const repo = 'Aigooz/pp-api-mobile';
const tag = process.argv[2];
if (!tag) throw new Error('Specify the release tag, for example: node tests/verify-release.mjs v1.13.0');
const apk = process.argv[3] || 'app/build/outputs/apk/release/app-release.apk';
const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest?verify=${Date.now()}`, {
  headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PpAPI-release-verification', 'X-GitHub-Api-Version': '2022-11-28' }
});
assert.equal(response.status, 200, 'GitHub latest release is unavailable');
const release = await response.json();
assert.equal(release.tag_name, tag);
assert.equal(release.draft, false);
assert.equal(release.prerelease, false);
const asset = release.assets.find(item => item.name === 'Pp-API-android.apk');
assert.ok(asset, 'APK missing');
assert.equal(asset.state, 'uploaded');
assert.equal(asset.browser_download_url, `https://github.com/${repo}/releases/download/${tag}/Pp-API-android.apk`);
const bytes = await readFile(apk);
const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
assert.equal(asset.size, bytes.length);
assert.equal(asset.digest, digest);
const download = await fetch(asset.browser_download_url);
assert.equal(download.status, 200, 'public download unavailable');
const downloaded = Buffer.from(await download.arrayBuffer());
assert.equal('sha256:' + createHash('sha256').update(downloaded).digest('hex'), digest);
console.log(`Public release ${tag}: APK metadata, SHA-256 and download verified`);
