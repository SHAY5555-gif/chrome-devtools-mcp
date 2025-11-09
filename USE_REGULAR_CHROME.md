# שימוש בפרופיל Chrome הרגיל

יש לך שתי אופציות להשתמש ב-MCP עם הפרופיל הרגיל של Chrome שלך (כולל כל התוספים וההגדרות):

## אופציה 1: שימוש ב-`--userDataDir` (מומלץ!)

זה הדרך הכי קלה - פשוט תגיד ל-MCP להשתמש בפרופיל הרגיל שלך.

### צעדים:

1. **עדכן את ה-MCP config** ב-Claude Code:

```bash
cd C:\projects\learn_ten_x_faster\chrome-devtools-mcp
claude mcp remove chrome-devtools-local-custom
claude mcp add chrome-devtools-local-custom node build/src/index.js --userDataDir="%LOCALAPPDATA%\Google\Chrome\User Data"
```

2. **זהו!** עכשיו כשתשתמש ב-MCP, הוא יפתח את Chrome עם הפרופיל הרגיל שלך.

### יתרונות:
✅ פשוט מאוד
✅ כל התוספים שלך עובדים
✅ כל ההגדרות שלך נשמרות
✅ ה-MCP פותח ומנהל את Chrome בשבילך

### חסרונות:
⚠️ לא תוכל לפתוח Chrome רגיל במקביל (רק דפדפן אחד יכול להשתמש בפרופיל בו-זמנית)

---

## אופציה 2: התחברות לדפדפן שרץ (עם `--browserUrl`)

אם אתה רוצה לפתוח את Chrome בעצמך ואז להתחבר אליו עם MCP:

### צעדים:

1. **פתח את Chrome עם debugging port**:

```bash
start-chrome-debug.bat
```

או ידנית:

```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\Google\Chrome\User Data"
```

2. **עדכן את ה-MCP config**:

```bash
claude mcp remove chrome-devtools-local-custom
claude mcp add chrome-devtools-local-custom node build/src/index.js --browserUrl=http://127.0.0.1:9222
```

3. **השתמש ב-MCP** - הוא יתחבר לדפדפן שכבר רץ

### יתרונות:
✅ שליטה מלאה על מתי Chrome נפתח
✅ יכול לגלוש בדפדפן ולהשתמש ב-MCP במקביל

### חסרונות:
⚠️ צריך לפתוח את Chrome בעצמך כל פעם
⚠️ צריך לזכור להריץ עם `--remote-debugging-port`

---

## בדיקה שהכל עובד

אחרי שעדכנת את הקונפיגורציה, נסה:

```
Check the performance of https://google.com
```

אם זה עובד - אתה אמור לראות את Chrome נפתח (או מתחבר) עם הפרופיל הרגיל שלך!

## פתרון בעיות

### Chrome לא נפתח?
- בדוק ש-Chrome סגור לפני שמנסים להשתמש באופציה 1
- אם משתמש באופציה 2, בדוק שהרצת את `start-chrome-debug.bat`

### "The browser is already running"?
- סגור את כל אינסטנסים של Chrome ונסה שוב
- או השתמש באופציה 2 (התחברות לדפדפן קיים)

### התוספים לא עובדים?
- בדוק שהשתמשת בנתיב הנכון ל-`userDataDir`
- הנתיב הסטנדרטי ב-Windows: `%LOCALAPPDATA%\Google\Chrome\User Data`
