const adapt = require('./_adapter');
const { handler } = require('../netlify/functions/telegram');
module.exports = adapt(handler);
