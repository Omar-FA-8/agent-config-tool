export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { business_id, password } = req.body;

  if (password !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  if (!business_id || !business_id.trim()) {
    return res.status(400).json({ error: 'Business ID is required' });
  }

  const query = `
    query GetMessages($business_id: uuid!) {
      core_message(
        where: { business_id: { _eq: $business_id } }
        order_by: { created_at: desc }
        limit: 5000
      ) {
        id
        direction
        body
        created_at
      }
    }
  `;

  try {
    const response = await fetch('https://graphql.mottasl.ai/v1/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hasura-admin-secret': process.env.HASURA_SECRET
      },
      body: JSON.stringify({
        query,
        variables: { business_id: business_id.trim() }
      })
    });

    const data = await response.json();

    if (data.errors) {
      return res.status(500).json({ error: 'Database error: ' + data.errors[0]?.message });
    }

    const messages = data.data?.core_message;

    if (!messages || messages.length === 0) {
      return res.status(404).json({ error: 'No messages found for this Business ID.' });
    }

    // Extract text from body — handles both string and JSON object formats
    function extractText(body) {
      if (!body) return null;
      if (typeof body === 'string') return body.trim() || null;
      if (typeof body === 'object') {
        // Try common text fields
        if (body.text) return body.text;
        if (body.body) return typeof body.body === 'string' ? body.body : null;
        // Template messages — extract text from components
        if (body.template?.components) {
          const texts = body.template.components
            .filter(c => c.type === 'body' && c.text)
            .map(c => c.text);
          if (texts.length) return texts.join(' ');
        }
        // Interactive messages
        if (body.interactive?.body?.text) return body.interactive.body.text;
        if (body.interactive?.header?.text) return body.interactive.header.text;
        // Caption or any nested text
        if (body.caption) return body.caption;
        if (body.image?.caption) return body.image.caption;
        if (body.video?.caption) return body.video.caption;
        if (body.document?.caption) return body.document.caption;
      }
      return null;
    }

    const formatted = messages
      .reverse()
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
      return res.status(404).json({ error: 'No readable message text found for this Business ID.' });
    }

    return res.status(200).json({
      message_count: messages.length,
      formatted_messages: formatted
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to reach database: ' + err.message });
  }
}
