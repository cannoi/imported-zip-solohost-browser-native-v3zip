'use strict';

const providerEngine = require('./provider-engine');

class AIService {
  async summarizeArticle(rawText, options = {}) {
    const prompt = `Please summarize the following article into 3-5 key bullet points:\n\n${rawText || ''}`;
    return providerEngine.complete(prompt, options);
  }

  async translateArticle(cleanHtml, targetLang = 'Vietnamese', options = {}) {
    const prompt = `Translate the following HTML article into ${targetLang}, preserving all HTML tags and structure exactly:\n\n${cleanHtml || ''}`;
    return providerEngine.complete(prompt, options);
  }

  async askQuestion(rawText, userQuery, options = {}) {
    const prompt = `Context:\n${rawText || ''}\n\nQuestion: ${userQuery || ''}\n\nAnswer based on the context above:`;
    return providerEngine.complete(prompt, options);
  }

  async analyze(rawText, options = {}) {
    const prompt = `Analyze the following article text and provide insights, key entities, and sentiment:\n\n${rawText || ''}`;
    return providerEngine.complete(prompt, options);
  }
}

module.exports = new AIService();
