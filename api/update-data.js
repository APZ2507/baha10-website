// ============================================================
//  Vercel Serverless Function — /api/update-data
//  מאמת סיסמת מנהל ומעדכן את data.json ישירות ב-GitHub.
//  שמירת השינוי ב-GitHub מפעילה Deploy אוטומטי ב-Vercel.
//
//  Environment Variables הנדרשים (Vercel → Settings → Environment Variables):
//    ADMIN_PASSWORD  - סיסמת המנהלים (Ovda10!)
//    GITHUB_TOKEN    - Personal Access Token עם הרשאת Contents: Read & Write
//    GITHUB_REPO     - owner/repo  (למשל: user/ovda-site)
//    GITHUB_BRANCH   - אופציונלי, ברירת מחדל: main
//    GITHUB_FILE_PATH- אופציונלי, ברירת מחדל: data.json
//
//  שום סוד אינו כתוב בקוד ואינו נשלח לדפדפן.
// ============================================================
console.log("ADMIN:", !!process.env.ADMIN_PASSWORD);
console.log("TOKEN:", !!process.env.GITHUB_TOKEN);
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

// בדיקת שפיות בסיסית למבנה הנתונים, כדי שלא יישמר קובץ פגום
function validate(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'מבנה נתונים לא תקין';
  if (!data.services || typeof data.services !== 'object') return 'חסר בלוק services';
  const arrays = ['phones', 'busRoutes', 'shuttles', 'guidelines', 'absorptionSteps'];
  for (const key of arrays) {
    if (!Array.isArray(data[key])) return `השדה ${key} חייב להיות רשימה`;
  }
  if (!data.busHours || typeof data.busHours !== 'object') return 'חסר בלוק busHours';
  const allowed = ['health', 'food', 'logistics', 'sport', 'transport', 'prayers'];
  for (const [id, s] of Object.entries(data.services)) {
    if (!s || typeof s !== 'object') return `שירות לא תקין: ${id}`;
    if (!s.name) return `לשירות ${id} חסר שם`;
    if (!allowed.includes(s.category)) return `לשירות ${id} יש קטגוריה לא חוקית: ${s.category}`;
    if (!s.hours || typeof s.hours !== 'object') return `לשירות ${id} חסרות שעות`;
  }
  const size = Buffer.byteLength(JSON.stringify(data), 'utf8');
  if (size > 1_000_000) return 'הקובץ גדול מדי';
  return null;
}

async function gh(path, token, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'ovda-admin-panel',
      ...(init.headers || {}),
    },
  });
  const body = await res.text();
  let json = null;
  try { json = JSON.parse(body); } catch (_) { /* ignore */ }
  return { ok: res.ok, status: res.status, json, body };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO = process.env.GITHUB_REPO;
  const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
  const FILE_PATH = process.env.GITHUB_FILE_PATH || 'data.json';

  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ ok: false, error: 'השרת אינו מוגדר: חסר ADMIN_PASSWORD' });
  }

  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (_) { payload = null; }
  }
  if (!payload) return res.status(400).json({ ok: false, error: 'בקשה לא תקינה' });

  const { action, password, data } = payload;

  if (!password || !timingSafeEqual(password, ADMIN_PASSWORD)) {
    // השהיה קצרה כדי להקשות על ניחוש סיסמאות
    await new Promise((r) => setTimeout(r, 600));
    return res.status(401).json({ ok: false, error: 'סיסמה שגויה' });
  }

  // בדיקת סיסמה בלבד (מסך הכניסה)
  if (action === 'verify') return res.status(200).json({ ok: true });

  if (action !== 'save') return res.status(400).json({ ok: false, error: 'פעולה לא מוכרת' });

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(500).json({ ok: false, error: 'השרת אינו מוגדר: חסרים GITHUB_TOKEN / GITHUB_REPO' });
  }

  const invalid = validate(data);
  if (invalid) return res.status(400).json({ ok: false, error: invalid });

  const content = JSON.stringify(data, null, 2) + '\n';
  const encoded = Buffer.from(content).toString('base64');
  const cleanPath = FILE_PATH.replace(/^\//, '');
  const base = `/repos/${GITHUB_REPO}/contents/${encodeURIComponent(cleanPath).replace(/%2F/g, '/')}`;

  try {
    // 1) שליפת ה-sha הנוכחי של הקובץ
    const current = await gh(`${base}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, GITHUB_TOKEN);
    if (!current.ok && current.status !== 404) {
      console.error('GitHub GET failed', current.status, current.body);
      return res.status(502).json({ ok: false, error: `שגיאת GitHub בקריאת הקובץ (${current.status})` });
    }
    const sha = current.ok && current.json ? current.json.sha : undefined;

    // 2) כתיבת הקובץ המעודכן (Commit) → Vercel מפרסם אוטומטית
    const put = await gh(base, GITHUB_TOKEN, {
      method: 'PUT',
      body: JSON.stringify({
        message: `עדכון תוכן דרך ממשק הניהול — ${new Date().toISOString()}`,
        content: encoded,
        branch: GITHUB_BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });

    if (!put.ok) {
      console.error('GitHub PUT failed', put.status, put.body);
      const msg = put.json && put.json.message ? put.json.message : put.status;
      return res.status(502).json({ ok: false, error: `שמירה ב-GitHub נכשלה: ${msg}` });
    }

    return res.status(200).json({
      ok: true,
      commit: put.json && put.json.commit ? put.json.commit.sha : null,
    });
  } catch (err) {
    console.error('update-data error', err);
    return res.status(500).json({ ok: false, error: 'שגיאה בלתי צפויה בשרת' });
  }
}
