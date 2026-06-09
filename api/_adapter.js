// Vercel ↔ Netlify handler adapter
// Netlify: exports.handler = async (event, context) => ({ statusCode, headers, body })
// Vercel:  module.exports = async (req, res) => res.status(N).json(...)
module.exports = function adapt(netlifyHandler) {
  return async (req, res) => {
    // Vercel auto-parses JSON bodies; Netlify expects a raw string
    const rawBody = req.body === undefined || req.body === null
      ? ''
      : typeof req.body === 'object'
      ? JSON.stringify(req.body)
      : String(req.body);

    const event = {
      httpMethod:            req.method,
      queryStringParameters: req.query || {},
      headers:               req.headers,
      body:                  rawBody,
      isBase64Encoded:       false,
    };

    let result;
    try {
      result = await netlifyHandler(event, {});
    } catch (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    res.status(result.statusCode || 200);
    if (result.headers) {
      Object.entries(result.headers).forEach(([k, v]) => res.setHeader(k, v));
    }
    res.end(result.body || '');
  };
};
