# breakingintobiglaw.com

A static site on GitHub Pages. It shows the guide PDF. Readers can highlight a passage and send a signed comment. After 30 seconds of reading, they are offered an update notice by email. Comments and emails are written to a Google Sheet through a Google Apps Script web app.

| File | Role |
|---|---|
| `index.html`, `assets/` | Reader page, styles and script (PDF.js 4.10.38 from jsDelivr) |
| `config.js` | Endpoint URL, document file and version, "update by" text, popup timing |
| `guide.pdf` | The document readers see |
| `backend/Code.gs` | Google Apps Script collector. Paste it into a Sheet. It is not used by the site at runtime. |
| `dev/serve.py` | Local preview with a mock backend. It writes to `dev/submissions.jsonl`. |
| `CNAME` | `breakingintobiglaw.com` |

## Publish a new version of the guide

1. Replace `guide.pdf`.
2. Change `documentVersion` in `config.js`. Each comment records the version it was made on. Readers' saved highlights are also kept per version, so old highlights do not land on new pages.
3. Commit and push. Pages redeploys in about a minute.

## One-time setup

### 1. Backend (Google Sheet), about 5 minutes

1. Create a Google Sheet, for example "breakingintobiglaw responses".
2. Open **Extensions → Apps Script**. Replace `Code.gs` with `backend/Code.gs` and save.
3. Optional: set `NOTIFY_EMAIL` to get an email for every comment.
4. Click **Deploy → New deployment**. Choose the type **Web app**, set **Execute as: Me** and **Who has access: Anyone**, then click Deploy.
5. Authorize the script. Google shows "unverified app": click **Advanced**, then **Go to …**.
6. Copy the `https://script.google.com/macros/s/…/exec` URL into `endpoint` in `config.js`.

The Sheet gets two tabs on first use:

- **Comments**: name, comment, quoted passage, page, version, and highlight position.
- **Subscribers**: one row per email.

Later code changes go through **Manage deployments → Edit → New version**. That keeps the same URL.

### 2. GitHub Pages

1. Create a public repo named `breakingintobiglaw-website` and push `main`.
2. Open **Settings → Pages** and set the source to branch `main`, folder `/`.
3. Check that the site works at `https://<account>.github.io/breakingintobiglaw-website/`.
4. Then set the custom domain to `breakingintobiglaw.com` (this repo's `CNAME` file). Once the certificate is issued, tick **Enforce HTTPS**.

### 3. DNS (Namecheap → Domain List → breakingintobiglaw.com → Advanced DNS)

Delete the parking records, then add these:

| Type | Host | Value |
|---|---|---|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| CNAME | `www` | `<account>.github.io.` |

This is the same setup as litfin501c.com, which runs from `hkishk2019/litfin501c-website` with its DNS at Cloudflare.

## Local preview

```bash
python3 dev/serve.py 8793
```

On `localhost`, a blank `endpoint` falls back to the mock backend at `/api/submit`.
