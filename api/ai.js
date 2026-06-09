const adapt = require('./_adapter');
const { handler } = require('../netlify/functions/ai');
module.exports = adapt(handler);
