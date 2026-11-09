import 'dotenv/config';

const BASE_URL = process.env.LLM_BASE_URL ?? 'https://api.groq.com/openai/v1';
const MODEL = process.env.LLM_MODEL ?? 'openai/gpt-oss-120b';

// The AI only writes the wording. Code checks the facts and falls back to the fixed template.
const FORBIDDEN = /(https?:\/\/|www\.|\bfees?\b|interest|penalt|lawyer|legal|court|collections|\bsue\b)/i;
const PHONE = /\+?\d[\d\s().-]{8,}\d/;
const unsafe = (s) => FORBIDDEN.test(s) || PHONE.test(s.replace(/\d{4}-\d{2}-\d{2}/g, '')); // dates are fine, phone numbers are not

export function validateReminder(out, inv) {
  if (!out || typeof out.subject !== 'string' || typeof out.note !== 'string') return null;
  const subject = out.subject.trim().replace(/\s+/g, ' ');
  const note = out.note.trim();
  if (!subject || subject.length > 100 || !note || note.length > 600) return null;
  if (unsafe(subject) || unsafe(note)) return null;
  const amt = Number(inv.amount);
  const flat = note.replace(/,/g, '');
  if (!flat.includes(String(amt)) && !flat.includes(amt.toFixed(2))) return null; // must state the real amount
  return { subject, note };
}

/** Level 0 = friendly, 1 = firm, 2+ = final notice. `fallback` is the existing template {subject, note}. */
export async function draftReminder(inv, level, overdue, tier, fallback) {
  if (!process.env.LLM_API_KEY) return fallback;
  const tone = ['friendly and light', 'polite but firm', 'final notice: direct and respectful'][Math.min(level, 2)];
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.LLM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, temperature: 0.4, max_tokens: 1500,
        messages: [
          { role: 'system', content:
            'You write payment reminder notes that a small merchant sends to a client through PayPal. ' +
            'Return ONLY JSON: {"subject": "...", "note": "..."}. Subject under 80 characters, note under 70 words. ' +
            'Use only the facts given, and state the invoice amount. Never invent fees, interest, penalties, dates or consequences. ' +
            'Never threaten, never include links or phone numbers, and never mention the client\'s payment history. Be respectful.' },
          { role: 'user', content: JSON.stringify({
            client: inv.client_name, amount: Number(inv.amount), currency: inv.currency ?? 'USD',
            for: inv.description, due_date: inv.due_date,
            status: overdue ? 'already past due' : 'due soon',
            reminder_number: level + 1, tone,
            client_tier: tier,
          }) },
        ],
      }),
    });
    if (!res.ok) return fallback;
    const choice = (await res.json()).choices?.[0];
    if (choice?.finish_reason === 'length') return fallback;
    const raw = choice?.message?.content ?? '';
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return fallback;
    return validateReminder(JSON.parse(json), inv) ?? fallback;
  } catch {
    return fallback;
  }
}