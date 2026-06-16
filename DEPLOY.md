# Deploying Brand Name Check to Netlify

## What's in this folder

| File | Purpose |
|---|---|
| `index.html` | The entire frontend — search UI, traffic lights, results table |
| `netlify/functions/search.js` | Serverless function that queries the WIPO trademark database |
| `netlify.toml` | Netlify build & routing config |

---

## Deploy in 3 steps

### 1. Push to GitHub
Create a new GitHub repo and push this folder to it.

```bash
git init
git add .
git commit -m "Initial Brand Name Check app"
git remote add origin https://github.com/YOUR_ORG/brand-name-check.git
git push -u origin main
```

### 2. Connect to Netlify
1. Go to [app.netlify.com](https://app.netlify.com) → **Add new site** → **Import an existing project**
2. Choose GitHub and select the repo
3. Build settings are auto-detected from `netlify.toml` — no changes needed
4. Click **Deploy**

### 3. That's it
No API keys or environment variables are required. The app queries the **WIPO Global Brand Database** (free, public) and covers US (USPTO), EU (EUIPO), and Sweden (PRV).

---

## Local development

```bash
npm install -g netlify-cli
netlify dev
```

Then open `http://localhost:8888`.

---

## Data sources & limitations

| Jurisdiction | Source | Notes |
|---|---|---|
| 🇺🇸 United States | USPTO via WIPO | Good coverage |
| 🇪🇺 European Union | EUIPO via WIPO | Good coverage |
| 🇸🇪 Sweden | PRV via WIPO | Partial — always verify directly at [PRV](https://tc.prv.se/VarumarkesDbWeb/?lang=EN) |

**This tool is for initial screening only. Results are not legal advice. Always consult a trademark attorney before filing.**
