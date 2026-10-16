'use strict';
/** Unified agent web tools: fetch, feed, article extract, playwright extract. */
const research = require('./agent-research-tools');
const tools = require('./agent-tools');

module.exports = Object.assign({}, research, tools, {
  // preferred aliases
  fetchDocumentText: tools.fetchDocumentText,
  extractFromPlaywrightSession: tools.extractFromPlaywrightSession,
  safeFetch: research.safeFetch,
  parseFeed: research.parseFeed,
  extractArticlesFromHtml: research.extractArticlesFromHtml,
  extractArticleMeta: research.extractArticleMeta
});
