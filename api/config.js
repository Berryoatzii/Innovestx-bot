const adapt = require('./_adapter');
const { handler } = require('../netlify/functions/config');
module.exports = adapt(handler);
