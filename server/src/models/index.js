/**
 * models/index.js
 * 
 * Single import point for all models.
 * Returns either real Mongoose models or in-memory implementations
 * depending on the USE_MEMORY env flag.
 */

if (process.env.USE_MEMORY === 'true') {
  console.log('[MODELS] 🧪 Using IN-MEMORY store (no MongoDB)');
  module.exports = require('../config/memoryStore');
} else {
  module.exports = {
    User:        require('./User'),
    Session:     require('./Session'),
    Upgrade:     require('./Upgrade'),
    Transaction: require('./Transaction'),
  };
}
