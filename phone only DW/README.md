# DripWriter — Phone Only

A standalone PWA that types into Google Docs **directly from your phone**. No laptop, no relay, no bridge, no extension. It signs into your Google account and inserts text with human-paced timing through the Google Docs API. Offline OCR (photo → sentences) is included.

## One-time Google setup

Google requires an OAuth client before any app can edit Docs on your behalf.

1. Go to https://console.cloud.google.com/ and create/select a project.
2. **APIs & Services → Library** → enable **Google Docs API**.
3. **APIs & Services → OAuth consent screen**: choose External, fill the basic fields, and add your Google account as a **Test user**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** → type **Web application**.
5. Under **Authorized redirect URIs**, add the exact URL where the PWA runs, e.g.
   ```
   https://your-tunnel-url/index.html
   ```
   (For local testing: `http://localhost:8765/index.html`. Google does not allow plain IP addresses as redirect URIs.)
6. Copy the **Client ID**. Paste it into the app's **Google OAuth Client ID** field.

## Run it

The app needs to be served over HTTP/HTTPS (not opened as a `file://` page).

Local test:
```powershell
cd "C:\Users\localuser\Downloads\newfolder\WORKING DW - Copy\phone only DW"
npx serve -l 8765
```
Then open `http://localhost:8765/index.html` and register that URL as the redirect URI.

On your phone, serve it over HTTPS (OAuth redirects require it), e.g. with a tunnel:
```
npx localtunnel --port 8765
```
Open the HTTPS URL on your phone, register `https://<tunnel>/index.html` as the redirect URI, and use that same URL on the phone.

## Use

1. Paste your **Client ID** and the **Google Doc link**, then tap **Sign in with Google** and approve access.
2. Add a draft, or use **Upload photo** → **Use in draft** to scan printed text into sentences.
3. Tap **Start typing**. The app writes the text into the Doc at your chosen WPM (with optional typos/auto-fixes). Pause, resume and stop work like the extension.

## Notes

- The Doc is edited through Google's API, so the text appears in the Doc on any device — it does not need a browser tab open.
- This does **not** use `content.js` keystroke insertion; that is only possible inside an extension with a content script, which a PWA cannot be.
- The Client ID and access token are stored only in your browser's local storage. Sign out to clear the token.
