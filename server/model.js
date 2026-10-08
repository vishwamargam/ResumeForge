const provider = (process.env.MODEL_PROVIDER || 'openai').toLowerCase();
const model = process.env.MODEL_NAME;
const key = process.env.MODEL_API_KEY;

function parseJsonObject(content) {
  const cleaned = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch {}
  for (let start = cleaned.indexOf('{'); start >= 0; start = cleaned.indexOf('{', start + 1)) {
    let depth = 0; let quoted = false; let escaped = false;
    for (let i = start; i < cleaned.length; i += 1) {
      const char = cleaned[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  throw new Error('Could not parse a complete JSON object.');
}

async function ask(system, prompt) {
  if (!key || !model) throw new Error('Configure MODEL_API_KEY and MODEL_NAME in your .env file first.');
  let url, headers;
  if (provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages';
    headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  } else if (provider === 'gemini') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    headers = { 'content-type': 'application/json' };
  } else {
    const base = process.env.MODEL_BASE_URL || 'https://api.openai.com/v1';
    url = `${base.replace(/\/$/, '')}/chat/completions`;
    headers = { Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const requestPrompt = attempt === 0 ? prompt : `${prompt}\n\nReturn only one complete, valid JSON object. Do not include Markdown, code fences, or explanatory text. Ensure every string and newline is escaped correctly.`;
    const strictSystem = `${system}\n\nOutput contract: return exactly one complete JSON object and no surrounding text.`;
    let body;
    if (provider === 'anthropic') {
      body = { model, max_tokens: 8192, system: strictSystem, messages: [{ role: 'user', content: requestPrompt }] };
    } else if (provider === 'gemini') {
      body = { systemInstruction: { parts: [{ text: strictSystem }] }, contents: [{ parts: [{ text: requestPrompt }] }], generationConfig: { temperature: 0.25, maxOutputTokens: 8192, responseMimeType: 'application/json' } };
    } else {
      body = { model, temperature: 0.25, max_tokens: 8192, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: strictSystem }, { role: 'user', content: requestPrompt }] };
    }
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || payload.message || `Model request failed (${response.status}).`);
    const content = provider === 'anthropic' ? payload.content?.find(c => c.type === 'text')?.text : provider === 'gemini' ? payload.candidates?.[0]?.content?.parts?.[0]?.text : payload.choices?.[0]?.message?.content;
    if (!content) throw new Error('The model returned an empty response. Check the selected model and provider settings.');
    try { return parseJsonObject(content); } catch (error) {
      if (attempt === 1) throw new Error(`The ${provider} model "${model}" returned incomplete or invalid JSON twice. This is usually caused by unsupported JSON mode, output truncation, or a custom prompt that conflicts with the required JSON response. Selected keywords are not normally the cause.`);
    }
  }
}

module.exports = { ask };
