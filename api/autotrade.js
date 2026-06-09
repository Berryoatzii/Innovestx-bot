const adapt = require('./_adapter');
const { handler } = require('../netlify/functions/autotrade');
module.exports = adapt(handler);
