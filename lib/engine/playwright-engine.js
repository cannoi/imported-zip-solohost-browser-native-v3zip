const { chromium } = require('playwright');

async function launchBrowser() {
  try {
    const browser = await chromium.launch({
      args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu']
    });
    browser.on('disconnected', () => {
      console.error('Chromium disconnected, attempting restart...');
      process.exit(1); // Trigger container restart
    });
    return browser;
  } catch (e) {
    console.error('Failed to launch browser:', e);
    throw e;
  }
}

module.exports = { launchBrowser };