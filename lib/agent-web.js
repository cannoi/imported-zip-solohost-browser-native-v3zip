'use strict';
/**
 * Single entry for agent HTTP/browser extraction tools.
 * Implementation split kept only for readability; all callers should require agent-web.
 */
const research = require('./agent-research-impl');
const tools = require('./agent-tools-impl');

module.exports = {
  safeFetch: research.safeFetch,
  parseFeed: research.parseFeed,
  extractArticlesFromHtml: research.extractArticlesFromHtml,
  extractArticleMeta: research.extractArticleMeta,
  discoverFeedLinks: research.discoverFeedLinks,
  assertSafeUrl: research.assertSafeUrl,
  clip: research.clip || tools.clip,
  extractPagePayload: tools.extractPagePayload,
  PAGE_EXTRACT_JS: tools.PAGE_EXTRACT_JS,
  extractFromPlaywrightSession: tools.extractFromPlaywrightSession,
  fetchDocumentText: tools.fetchDocumentText,
  MAX_TEXT: tools.MAX_TEXT
};
