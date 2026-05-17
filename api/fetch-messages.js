export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { business_id, password } = req.body;

  // ── Auth ────────────────────────────────────────────────────────────────────
  if (password !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  // ── FIX: Validate business_id before anything else ──────────────────────────
  // Previously the check was `!business_id || !business_id.trim()` but if
  // business_id arrived as undefined the .trim() call itself threw, masking
  // the real error. Now we safely coerce first.
  const cleanBizId = (business_id || '').trim();
  if (!cleanBizId) {
    return res.status(400).json({ error: 'Business ID is required' });
  }

  if (!process.env.HASURA_SECRET) {
    return res.status(500).json({ error: 'HASURA_SECRET is not configured.' });
  }

  const HASURA_URL = 'https://graphql.mottasl.ai/v1/graphql';

  const BATCH_SIZE      = Number(process.env.HASURA_FETCH_BATCH_SIZE    || 100);
  const MAX_UNIQUE      = Number(process.env.HASURA_MAX_UNIQUE_MESSAGES  || 500);
  const TIMEOUT_MS      = Number(process.env.HASURA_BATCH_TIMEOUT_MS     || 7000);
  const DAYS_BACK       = Number(process.env.HASURA_DAYS_BACK            || 30);

  const since = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('Z', '');

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function normalizeDirection(direction) {
    if (!direction) return '';
    return String(direction).toLowerCase().trim();
  }

  function isUsefulMessage(msg) {
    const body      = msg.body || {};
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
      if (body.text?.body)                          return String(body.text.body).trim()        || null;
      if (typeof body.text === 'string')            return body.text.trim()                     || null;
      if (body.interactive?.body?.text)             return String(body.interactive.body.text).trim() || null;
      if (body.caption)                             return String(body.caption).trim()          || null;
      if (body.image?.caption)                      return String(body.image.caption).trim()    || null;
      if (body.video?.caption)                      return String(body.video.caption).trim()    || null;
      if (body.document?.caption)                   return String(body.document.caption).trim() || null;
      if (body.template?.components && Array.isArray(body.template.components)) {
        const texts = body.template.components
          .filter(c => c && c.type === 'body' && c.text)
          .map(c => c.text);
        if (texts.length) return texts.join(' ').trim() || null;
      }
    }
    return null;
  }

  // ── Fetch ───────────────────────────────────────────────────────────────────
  async function fetchBatch() {
    const query = `
      query GetMessages($business_id: uuid!, $limit: Int!, $since: timestamp!) {
        core_message(
          where: {
            business_id: { _eq: $business_id }
            created_at:  { _gte: $since }
          }
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
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(HASURA_URL, {
        method: 'POST',
        headers: {
          'Content-Type':          'application/json',
          'x-hasura-admin-secret': process.env.HASURA_SECRET,
        },
        body: JSON.stringify({
          query,
          variables: { business_id: cleanBizId, limit: BATCH_SIZE, since },
        }),
        signal: controller.signal,
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
      clearTimeout(timer);
    }
  }

  // ── Execute ─────────────────────────────────────────────────────────────────
  const result = await fetchBatch();

  if (!result.success || !result.messages.length) {
    const reason = result.timedOut
      ? 'Could not fetch messages — Hasura is too slow for this merchant. Try again or contact support to add a DB index.'
      : result.error
        ? `Hasura error: ${result.error}`
        : `No messages found for this Business ID in the last ${DAYS_BACK} days.`;
    return res.status(404).json({ error: reason });
  }

  // ── Filter & Format ─────────────────────────────────────────────────────────
  const usefulMessages = result.messages.filter(isUsefulMessage);

  if (!usefulMessages.length) {
    return res.status(404).json({
      error: 'Messages found but no useful customer/agent messages after filtering.',
    });
  }

  const lines = usefulMessages
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map(m => {
      const direction = normalizeDirection(m.direction);
      const sender    = (direction === 'inbound' || direction === 'in') ? 'Customer' : 'Agent';
      const date      = new Date(m.created_at).toLocaleDateString('en-GB');
      const text      = extractText(m.body);
      if (!text) return null;
      return `[${date}] ${sender}: ${text}`;
    })
    .filter(Boolean);

  // ── Deduplicate ─────────────────────────────────────────────────────────────
  const seen   = new Set();
  const deduped = [];
  for (const line of lines) {
    const key = line.replace(/^\[.*?\]\s*(Customer|Agent):\s*/, '').trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      deduped.push(line);
    }
    if (deduped.length >= MAX_UNIQUE) break;
  }

  if (!deduped.length) {
    return res.status(404).json({ error: 'No readable message text found.' });
  }

  return res.status(200).json({
    message_count:          result.messages.length,
    filtered_message_count: usefulMessages.length,
    unique_count:           deduped.length,
    stopped_early:          false,
    formatted_messages:     deduped.join('\n'),
  });
}
