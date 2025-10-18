module.exports = {
  esbuild: {
    platform: 'node',
    target: 'node20',
    external: [
      'chrome-devtools-frontend',
      'puppeteer',
      'puppeteer-core',
    ],
  },
};
