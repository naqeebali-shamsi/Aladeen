
import { registry } from './adapters/index.js';

export * from './adapters/index.js';

console.log('Aladeen Core Framework Loaded');
console.log('Available providers:', registry.listAdapters().map(a => a.name).join(', '));
