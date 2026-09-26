// Loads src/*.gs into one shared scope, the way Apps Script does, with optional fake globals.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadGas(globals = {}) {
  const ctx = vm.createContext({ console, Date, JSON, Math, ...globals });
  const dir = path.join(__dirname, '..', 'src');
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.gs')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

// Recorded Gemini answers from scripts/live-eval.js, keyed by fixture id.
function recorded(id) {
  return fs.readFileSync(path.join(__dirname, 'recorded', id + '.json'), 'utf8');
}

module.exports = { loadGas, recorded };
