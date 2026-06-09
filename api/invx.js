const adapt = require('./_adapter');
const { handler } = require('../netlify/functions/invx');
module.exports = adapt(handler);
