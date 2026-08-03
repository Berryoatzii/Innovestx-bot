// Primary Telegram webhook entry point.
// Easy Mode handles the simple one-click flow, then delegates advanced commands
// and signed live-order approvals to telegram-advanced.js.
module.exports = require('./easy-telegram');
