#!/usr/bin/env node
/**
 * Entry point used by VS Code (F5) and `npm start`.
 * Checks the Node version before anything touches node:sqlite, then starts the server.
 */
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 16)) {
  console.error(`\n  Node ${process.versions.node} is too old. This project needs Node 22.16 or newer (built-in node:sqlite).`);
  console.error('  Install the current LTS from https://nodejs.org, restart VS Code, then press F5 again.\n');
  process.exit(1);
}
process.removeAllListeners('warning'); // hide the node:sqlite ExperimentalWarning
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });
await import('./index.js');
