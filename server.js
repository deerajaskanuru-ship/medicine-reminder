const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const https = require('https');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

function getApiKey() {
  try { return require('./config.json').apiKey; } catch (e) { return null; }
}

// Helper: call Anthropic API from Node (no CORS issue)
function callAnthropic(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from API: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// POST /api/ocr — upload image, get extracted text
app.post('/api/ocr', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const apiKey = getApiKey();
  if (!apiKey) return res.status(500).json({ error: 'API key not set in config.json' });

  try {
    const base64 = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype;

    const data = await callAnthropic({
      model: 'claude-opus-4-5',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: 'You are an expert medical prescription reader. Extract ALL visible text from this prescription image exactly as written. This may be handwritten or printed. Read every word carefully including patient name, age, date, doctor name, hospital/clinic name, diagnosis, every medicine name, dosage, frequency, duration, and instructions. Return ONLY the raw extracted text. If unclear write your best guess followed by (unclear).' }
        ]
      }]
    });

    if (data.error) return res.status(500).json({ error: data.error.message });
    const text = (data.content || []).map(c => c.text || '').join('').trim();
    if (!text) return res.status(500).json({ error: 'No text could be read from image' });
    res.json({ success: true, text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/parse — text → structured JSON
app.post('/api/parse', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });
  const apiKey = getApiKey();
  if (!apiKey) return res.status(500).json({ error: 'API key not set in config.json' });

  try {
    const data = await callAnthropic({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Parse the prescription text below into JSON. Return ONLY raw JSON, no markdown, no explanation. Use null for missing fields. Extract EVERY medicine mentioned.

JSON format:
{"patient_name":null,"patient_age":null,"patient_gender":null,"date":null,"doctor_name":null,"hospital_clinic":null,"diagnosis":null,"medications":[{"name":null,"dosage":null,"frequency":null,"duration":null,"instructions":null}],"notes":null}

Prescription:
${text}`
      }]
    });

    if (data.error) return res.status(500).json({ error: data.error.message });
    let raw = (data.content || []).map(c => c.text || '').join('').trim();
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'Could not extract JSON from response' });
    const parsed = JSON.parse(match[0]);
    res.json({ success: true, data: parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve React app for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'getstarted.html'));
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log('\n✅ Medicare Reminder running!');
  console.log(`👉 Open this in your browser: http://localhost:${PORT}\n`);
});
