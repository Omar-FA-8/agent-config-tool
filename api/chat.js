export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { business_id, password } = req.body;

  if (password !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  if (!business_id || !business_id.trim()) {
    return res.status(400).json({ error: 'Business ID is required' });
  }

  if (!process.env.HASURA_SECRET) {
    return res.status(500).json({ error: 'HASURA_SECRET is not configured.' });
  }

  const HASURA_URL = 'https://graphql.mottasl.ai/v1/graphql';

  // Single-batch fetch — one query, no looping, avoids Vercel timeout
  const LIMIT = Number(process.env.HASURA_FETCH_LIMIT || 150);
  const MAX_UNIQUE_MESSAGES = Number(process.env.HASURA_MAX_UNIQUE_MESSAGES || 100);
  const HASURA_REQUEST_TIMEOUT_MS = Number(process.env.HASURA_REQUEST_TIMEOUT_MS || 8000);

  function normalizeDirection(direction) {
    if (!direction) return '';
    return String(direction).toLowerCase().trim();
  }

  function isUsefulMessage(msg) {
    const body = msg.body || {};
    const direction = normalizeDirection(msg.direction);
    if (direction === 'inbound' || direction === 'in') return true;
    if (
      (direction === 'outbound' || direction === 'out') &&
      body && typeof body === 'object' && body.source === 'agent'
    ) return true;
    return false;
  }

  function extractText(body) {
    if (!body) return null;
    if (typeof body === 'string') return body.trim() || null;
    if (typeof body === 'object') {
      if (body.text?.body) return String(body.text.body).trim() || null;
      if (typeof body.text === 'string') return body.text.trim() || null;
      if (body.template?.components && Array.isArray(body.template.components)) {
        const texts = body.template.components
          .filter((c) => c && c.type === 'body' && c.text)
          .map((c) => c.text);
        if (texts.length) return texts.join(' ').trim() || null;
      }
      if (body.interactive?.body?.text) return String(body.interactive.body.text).trim() || null;
      if (body.caption) return String(body.caption).trim() || null;
      if (body.image?.caption) return String(body.image.caption).trim() || null;
      if (body.video?.caption) return String(body.video.caption).trim() || null;
      if (body.document?.caption) return String(body.document.caption).trim() || null;
    }
    return null;
  }

  // Filter by last N days — avoids full table scan on large merchants (e.g. 135k rows)
  const DAYS_BACK = Number(process.env.HASURA_DAYS_BACK || 30);
  const since = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000).toISOString();

  const query = `
    query GetMessages($business_id: uuid!, $limit: Int!, $since: timestamptz!) {
      core_message(
        where: {
          business_id: { _eq: $business_id }
          created_at: { _gte: $since }
        }
        order_by: { created_at: desc }
        limit: $limit
      ) {
        id
        direction
        body
        created_at
      }
    }
  `;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HASURA_REQUEST_TIMEOUT_MS);

  let rawMessages = [];

  try {
    const response = await fetch(HASURA_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hasura-admin-secret': process.env.HASURA_SECRET
      },
      body: JSON.stringify({
        query,
        variables: { business_id: business_id.trim(), limit: LIMIT, since }
      }),
      signal: controller.signal
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return res.status(500).json({ error: 'Hasura returned non-JSON response.' });
    }

    if (!response.ok || data.errors) {
      const msg = data.errors?.[0]?.message || data.error || `HTTP ${response.status}`;
      return res.status(500).json({ error: 'Hasura error: ' + msg });
    }

    rawMessages = data.data?.core_message || [];
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: `Hasura request timed out after ${HASURA_REQUEST_TIMEOUT_MS / 1000} seconds. Try a different Business ID or contact support.` });
    }
    return res.status(500).json({ error: 'Failed to fetch messages: ' + err.message });
  } finally {
    clearTimeout(timeout);
  }

  if (!rawMessages.length) {
    return res.status(404).json({ error: 'No messages found for this Business ID.' });
  }

  const usefulMessages = rawMessages.filter(isUsefulMessage);

  if (!usefulMessages.length) {
    return res.status(404).json({ error: 'Messages found but no useful customer/agent messages after filtering.' });
  }

  const formatted = usefulMessages
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map((m) => {
      const direction = normalizeDirection(m.direction);
      const sender = direction === 'inbound' || direction === 'in' ? 'Customer' : 'Agent';
      const date = new Date(m.created_at).toLocaleDateString('en-GB');
      const text = extractText(m.body);
      if (!text) return null;
      return `[${date}] ${sender}: ${text}`;
    })
    .filter(Boolean)
    .join('\n');

  if (!formatted) {
    return res.status(404).json({ error: 'No readable message text found.' });
  }

  const lines = formatted.split('\n');
  const seen = new Set();
  const deduped = [];

  for (const line of lines) {
    const textPart = line.replace(/^\[.*?\]\s*(Customer|Agent):\s*/, '').trim().toLowerCase();
    if (textPart && !seen.has(textPart)) {
      seen.add(textPart);
      deduped.push(line);
    }
    if (deduped.length >= MAX_UNIQUE_MESSAGES) break;
  }

  return res.status(200).json({
    message_count: rawMessages.length,
    filtered_message_count: usefulMessages.length,
    unique_count: deduped.length,
    formatted_messages: deduped.join('\n')
  });
}
