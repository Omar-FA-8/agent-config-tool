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
        business_id
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
      const errMsg = data.errors[0]?.message || 'Hasura query failed';
      return res.status(500).json({ error: 'Database error: ' + errMsg });
    }

    const messages = data.data?.core_message;

    if (!messages || messages.length === 0) {
      return res.status(404).json({ error: 'No messages found for this Business ID. Please check the ID and try again.' });
    }

    // Format messages into readable text for the AI
    const formatted = messages
      .reverse()
      .map(m => {
        const sender = m.direction === 'inbound' ? 'Customer' : 'Agent';
        const date = new Date(m.created_at).toLocaleDateString('en-GB');
        const body = (m.body || '').trim();
        if (!body) return null;
        return `[${date}] ${sender}: ${body}`;
      })
      .filter(Boolean)
      .join('\n');

    return res.status(200).json({
      message_count: messages.length,
      formatted_messages: formatted
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to reach database: ' + err.message });
  }
}
