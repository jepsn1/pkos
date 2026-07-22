/**
 * Self-contained drag-drop upload page served at GET /api/attachments/upload.
 * No build step, no external assets — posts to /api/attachments and shows a
 * ready-to-paste markdown snippet (image embed or link) for each stored file.
 * Lives in this repo (version-controlled); Open WebUI is never touched.
 */
export const UPLOAD_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PKOS · Upload</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --line:#ddd; --accent:#3b6ea5; --card:#f7f7f8; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16181c; --fg:#e8e8ea; --muted:#9aa0a6; --line:#2c2f36; --accent:#6ea8fe; --card:#1e2126; } }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.5 system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width:640px; margin:0 auto; padding:24px 16px 64px; }
  h1 { font-size:1.3rem; margin:0 0 4px; }
  p.sub { color:var(--muted); margin:0 0 20px; }
  #drop { border:2px dashed var(--line); border-radius:14px; padding:40px 16px; text-align:center; cursor:pointer; transition:border-color .15s, background .15s; }
  #drop.over { border-color:var(--accent); background:var(--card); }
  #drop strong { color:var(--accent); }
  input[type=file] { display:none; }
  .item { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px; margin-top:12px; }
  .item .name { font-weight:600; word-break:break-all; }
  .item .meta { color:var(--muted); font-size:.85rem; margin:2px 0 8px; }
  .row { display:flex; gap:8px; align-items:center; }
  code { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:6px 8px; font-size:.8rem; flex:1; overflow-x:auto; white-space:nowrap; }
  button.copy { border:1px solid var(--line); background:var(--bg); color:var(--fg); border-radius:8px; padding:6px 10px; cursor:pointer; font-size:.8rem; white-space:nowrap; }
  button.copy:active { background:var(--card); }
  .err { color:#c33; font-size:.9rem; margin-top:8px; }
  progress { width:100%; margin-top:8px; }
</style>
</head>
<body>
<main>
  <h1>Upload to PKOS</h1>
  <p class="sub">Drop files to store them. You'll get a link + a ready-to-paste markdown snippet for your notes.</p>
  <label id="drop" for="picker">
    <div>Drag files here, or <strong>tap to choose</strong></div>
  </label>
  <input id="picker" type="file" multiple />
  <div id="list"></div>
</main>
<script>
  const drop = document.getElementById('drop');
  const picker = document.getElementById('picker');
  const list = document.getElementById('list');

  drop.addEventListener('click', () => picker.click());
  ['dragenter','dragover'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add('over'); }));
  ['dragleave','drop'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', ev => upload(ev.dataTransfer.files));
  picker.addEventListener('change', () => upload(picker.files));

  function isImage(mime) { return (mime || '').startsWith('image/'); }
  function snippet(a) { return isImage(a.mime) ? '![' + a.filename + '](' + a.url + ')' : '[' + a.filename + '](' + a.url + ')'; }

  async function upload(files) {
    for (const file of files) {
      const card = document.createElement('div');
      card.className = 'item';
      card.innerHTML = '<div class="name"></div><div class="meta">uploading…</div><progress></progress>';
      card.querySelector('.name').textContent = file.name;
      list.prepend(card);
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch('/api/attachments', { method: 'POST', body: fd });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const a = await res.json();
        const md = snippet(a);
        card.innerHTML =
          '<div class="name"></div>' +
          '<div class="meta">' + (a.mime || '') + ' · ' + fmtSize(a.size) + '</div>' +
          '<div class="row"><code></code><button class="copy">Copy markdown</button></div>';
        card.querySelector('.name').textContent = a.filename;
        card.querySelector('code').textContent = md;
        const btn = card.querySelector('.copy');
        btn.addEventListener('click', async () => {
          const ok = await copyText(md);
          btn.textContent = ok ? 'Copied ✓' : 'Copy failed — select it';
          setTimeout(() => btn.textContent = 'Copy markdown', 1600);
        });
      } catch (e) {
        card.innerHTML = '<div class="name"></div><div class="err"></div>';
        card.querySelector('.name').textContent = file.name;
        card.querySelector('.err').textContent = 'Upload failed: ' + e.message;
      }
    }
  }
  function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n/1024).toFixed(1) + ' KB' : (n/1048576).toFixed(1) + ' MB'; }
  // navigator.clipboard needs a secure context (HTTPS); over plain-HTTP tailscale
  // it's undefined, so fall back to a hidden-textarea + execCommand copy.
  async function copyText(text) {
    try { if (navigator.clipboard) { await navigator.clipboard.writeText(text); return true; } } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
    } catch { return false; }
  }
</script>
</body>
</html>`;
