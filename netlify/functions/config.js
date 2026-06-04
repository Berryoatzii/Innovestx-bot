// Netlify Function: /api/config
// ส่ง config ที่ไม่ sensitive กลับไปให้ Dashboard
// Key จริงอยู่ใน Environment Variables ฝั่ง Server เท่านั้น

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:cors, body:'' };

  // ส่งแค่ว่า Key มีอยู่ไหม ไม่ส่งค่าจริง
  return {
    statusCode: 200,
    headers: cors,
    body: JSON.stringify({
      invxReady:    !!(process.env.INVX_KEY && process.env.INVX_SECRET),
      geminiReady:  !!(process.env.GEMINI_API_KEY),
      telegramReady:!!(process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID),
    })
  };
};
