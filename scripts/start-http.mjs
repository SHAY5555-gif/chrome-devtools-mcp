process.env.TRANSPORT = process.env.TRANSPORT ?? 'http';
await import('../build/src/index.js');
