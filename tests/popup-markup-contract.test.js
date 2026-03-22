const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const popupHtmlPath = path.resolve(__dirname, '..', 'popup.html');

function readPopupHtml() {
  return fs.readFileSync(popupHtmlPath, 'utf8');
}

test('popup no longer renders redundant per-run provider override controls in main view', () => {
  const html = readPopupHtml();

  [
    'captureOptionsPanel',
    'btnToggleCaptureOptions',
    'captureOptionsBody',
    'captureOptionsTitle',
    'providerOverrideSelect',
    'providerOverrideHint'
  ].forEach((id) => {
    assert.doesNotMatch(html, new RegExp(`id=["']${id}["']`), `unexpected #${id} in popup.html`);
  });
});

test('popup keeps provider settings mount points for credential inputs', () => {
  const html = readPopupHtml();

  ['defaultProviderSelect', 'providerCards', 'btnSaveProviders'].forEach((id) => {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id} in popup.html`);
  });
});

test('popup detail view exposes summary action and render mounts', () => {
  const html = readPopupHtml();

  [
    'detailSummarySection',
    'btnDetailSummarize',
    'detailSummaryStatus',
    'detailSummaryBadge',
    'detailSummaryCard',
    'detailSummaryText',
    'detailSummaryKeyPoints',
    'detailSummaryError'
  ].forEach((id) => {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id} in popup.html`);
  });
});
