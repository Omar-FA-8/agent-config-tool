export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { business_id, password } = req.body;

  if (password !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  if (!business_id || !business_id.trim()) {
    return res.status(400).json({ error: 'Business ID is required' });
  }

  const HASURA_URL = 'https://graphql.mottasl.ai/v1/graphql';
  const BATCH_SIZE = 500;
  const TOTAL = 5000;

  const fetchBatch = async (offset) => {
    const query = `
      query GetMessages($business_id: uuid!, $offset: Int!) {
        core_message(
          where: { business_id: { _eq: $business_id } }
          order_by: { created_at: desc }
          limit: ${BATCH_SIZE}
          offset: $offset
        ) {
          id
          direction
          body
          created_at
        }
      }
    `;

    const response = await fetch(HASURA_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hasura-admin-secret': process.env.HASURA_SECRET
      },
      body: JSON.stringify({
        query,
        variables: { business_id: business_id.trim(), offset }
      })
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('Hasura returned invalid response: ' + text.substring(0, 150));
    }
    if (data.errors) throw new Error(data.errors[0]?.message);
    return data.data?.core_message || [];
  };

  // Extract readable text from any message body format
  function extractText(body) {
    if (!body) return null;
    if (typeof body === 'string') return body.trim() || null;
    if (typeof body === 'object') {
      // Most common: body.text.body
      if (body.text?.body) return body.text.body;
      // Plain text
      if (typeof body.text === 'string') return body.text;
      // Template messages
      if (body.template?.components) {
        const texts = body.template.components
          .filter(c => c.type === 'body' && c.text)
          .map(c => c.text);
        if (texts.length) return texts.join(' ');
      }
      // Interactive
      if (body.interactive?.body?.text) return body.interactive.body.text;
      // Captions
      if (body.caption) return body.caption;
      if (body.image?.caption) return body.image.caption;
      if (body.video?.caption) return body.video.caption;
      if (body.document?.caption) return body.document.caption;
    }
    return null;
  }

  try {
    // Fetch all batches in parallel
    const offsets = Array.from({ length: TOTAL / BATCH_SIZE }, (_, i) => i * BATCH_SIZE);
    const batches = await Promise.all(offsets.map(offset => fetchBatch(offset)));
    const allMessages = batches.flat();

    if (!allMessages.length) {
      return res.status(404).json({ error: 'No messages found for this Business ID.' });
    }

    // Sort chronologically and format
    const formatted = allMessages
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map(m => {
        const sender = m.direction === 'inbound' ? 'Customer' : 'Agent';
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

    return res.status(200).json({
      message_count: allMessages.length,
      formatted_messages: formatted
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch messages: ' + err.message });
  }
}
