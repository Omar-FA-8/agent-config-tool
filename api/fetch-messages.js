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

  // Batched with graceful degradation:
  // - Fetch in small batches with a tight per-batch timeout
  // - If a batch times out or fails, stop and use whatever we have so far
  const BATCH_SIZE = Number(process.env.HASURA_FETCH_BATCH_SIZE || 100);
  const MAX_BATCHES = Number(process.env.HASURA_MAX_BATCHES || 5); // max 500 messages total
  const MAX_UNIQUE_MESSAGES = Number(process.env.HASURA_MAX_UNIQUE_MESSAGES || 500);
  const BATCH_TIMEOUT_MS = Number(process.env.HASURA_BATCH_TIMEOUT_MS || 7000); // 7s per batch

  // Date filter — only last N days to reduce scan size
  const DAYS_BACK = Number(process.env.HASURA_DAYS_BACK || 30);
  const since = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000).toISOString();

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

  async function fetchBatch(offset) {
    const query = `
      query GetMessages($business_id: uuid!, $limit: Int!, $offset: Int!, $since: timestamptz!) {
        core_message(
          where: {
            business_id: { _eq: $business_id }
            created_at: { _gte: $since }
          }
          order_by: { created_at: desc }
          limit: $limit
          offset: $offset
        ) {
          id
          direction
          body
          created_at
        }
      }
    `;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BATCH_TIMEOUT_MS);

    try {
      const response = await fetch(HASURA_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hasura-admin-secret': process.env.HASURA_SECRET
        },
        body: JSON.stringify({
          query,
          variables: {
            business_id: business_id.trim(),
            limit: BATCH_SIZE,
            offset,
            since
          }
        }),
        signal: controller.signal
      });

      const text = await response.text();
      let data;
      try { data = JSON.parse(text); }
      catch (e) { throw new Error('Hasura returned non-JSON response.'); }

      if (!response.ok || data.errors) {
        const msg = data.errors?.[0]?.message || `HTTP ${response.status}`;
        throw new Error(msg);
      }

      return { success: true, messages: data.data?.core_message || [] };
    } catch (err) {
      if (err.name === 'AbortError') {
        return { success: false, timedOut: true, messages: [] };
      }
      return { success: false, error: err.message, messages: [] };
    } finally {
      clearTimeout(timeout);
    }
  }

  // Fetch batches — stop gracefully on timeout or empty batch
  const rawMessages = [];
  let stoppedEarly = false;
  let batchesFetched = 0;

  for (let i = 0; i < MAX_BATCHES; i++) {
    const offset = i * BATCH_SIZE;
    const result = await fetchBatch(offset);
    batchesFetched++;

    if (!result.success) {
      // Timed out or errored — stop and use what we have
      stoppedEarly = true;
      break;
    }

    if (!result.messages.length) {
      // No more messages
      break;
    }

    rawMessages.push(...result.messages);

    if (result.messages.length < BATCH_SIZE) {
      // Last batch had fewer than requested — no more to fetch
      break;
    }
  }

  // If we got nothing at all, return error
  if (!rawMessages.length) {
    return res.status(404).json({
      error: stoppedEarly
        ? `Could not fetch messages — Hasura is too slow for this merchant. Try again or contact support to add a DB index.`
        : 'No messages found for this Business ID in the last ' + DAYS_BACK + ' days.'
    });
  }

  const usefulMessages = rawMessages.filter(isUsefulMessage);

  if (!usefulMessages.length) {
    return res.status(404).json({
      error: 'Messages found but no useful customer/agent messages after filtering.'
    });
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
    batches_fetched: batchesFetched,
    stopped_early: stoppedEarly,
    formatted_messages: deduped.join('\n')
  });
}
