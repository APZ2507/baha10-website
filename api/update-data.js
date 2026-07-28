// api/update-data.js
// Vercel Serverless Function.
//
// מטפלת בשתי פעולות שנשלחות מ-index.html (מדף המנהלים, בתוך הקובץ עצמו):
//   { action: 'verify', password }        -> רק בודקת שהסיסמה נכונה, לפני שמציגים את עורך הנתונים
//   { action: 'save',   password, data }  -> אם הסיסמה נכונה, מפרסמת את data.json החדש ישירות ל-GitHub
//
// ה-GITHUB_TOKEN לעולם לא מגיע לדפדפן - הוא זמין רק כאן, בצד השרת, דרך Vercel Environment Variables.
//
// משתני סביבה נדרשים (Vercel -> Project Settings -> Environment Variables):
//   ADMIN_PASSWORD   - הסיסמה שמוזנת בדף המנהלים (למשל Ovda10!)
//   GITHUB_TOKEN     - Personal Access Token (מומלץ Fine-grained), הרשאת Contents: Read and write על הריפו הזה בלבד
//   GITHUB_OWNER     - שם המשתמש/הארגון ב-GitHub, לדוגמה 'my-user'
//   GITHUB_REPO      - שם הריפו
//   GITHUB_BRANCH    - שם הענף (אופציונלי, ברירת מחדל: main)

const GITHUB_FILE_PATH = 'data.json'; // הנתיב לקובץ בתוך הריפו - שנו כאן אם הקובץ יעבור למיקום אחר

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const { action, password, data } = body || {};

  // אימות סיסמה - משותף לשתי הפעולות
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    res.status(401).json({ ok: false, error: 'סיסמה שגויה' });
    return;
  }

  // פעולה 1: רק בדיקת סיסמה (בלי לגעת ב-GitHub בכלל)
  if (action === 'verify') {
    res.status(200).json({ ok: true });
    return;
  }

  // פעולה 2: שמירה בפועל - מפרסמת ל-GitHub
  if (action === 'save') {
    if (!data) {
      res.status(400).json({ ok: false, error: 'לא התקבל תוכן לשמירה' });
      return;
    }

    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';
    const token = process.env.GITHUB_TOKEN;

    if (!owner || !repo || !token) {
      res.status(500).json({ ok: false, error: 'השרת לא מוגדר (חסרים משתני סביבה ב-Vercel: GITHUB_OWNER / GITHUB_REPO / GITHUB_TOKEN)' });
      return;
    }

    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${GITHUB_FILE_PATH}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'base-services-admin',
    };

    try {
      // חייבים את ה-sha הנוכחי של הקובץ כדי לעדכן אותו (כך עובד GitHub Contents API)
      let sha;
      const getRes = await fetch(`${apiUrl}?ref=${branch}`, { headers });
      if (getRes.ok) {
        const j = await getRes.json();
        sha = j.sha;
      }

      const content = Buffer.from(JSON.stringify(data, null, 2), 'utf-8').toString('base64');
      const putBody = {
        message: 'עדכון data.json מדף הניהול',
        content,
        branch,
      };
      if (sha) putBody.sha = sha;

      const putRes = await fetch(apiUrl, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(putBody),
      });

      if (!putRes.ok) {
        const err = await putRes.json().catch(() => ({}));
        res.status(502).json({ ok: false, error: err.message || putRes.statusText });
        return;
      }

      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
    return;
  }

  res.status(400).json({ ok: false, error: 'פעולה לא מוכרת' });
};
