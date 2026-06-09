const adapt = require('./_adapter');
const { handler } = require('../netlify/functions/autotrader-trigger');
module.exports = adapt(handler);
