const adapt = require('./_adapter');
const { handler } = require('../netlify/functions/agents');
module.exports = adapt(handler);
