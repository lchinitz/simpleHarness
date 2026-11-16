/* ═══════════════════════════════════════════════════════════════
   LLM Coding Harness – browser-side logic
   ═══════════════════════════════════════════════════════════════ */

// ── State ───────────────────────────────────────────────────────
let messages      = [];      // full conversation history sent to API
let selectedFiles = [];      // { name, content, lines }
let isSending     = false;

// ── DOM refs ────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const modelSelect   = $('model-select');
const fileInput     = $('file-input');
const addFilesBtn   = $('add-files-btn');
const fileList      = $('file-list');
const dropZone      = $('drop-zone');
const promptInput   = $('prompt-input');
const sendBtn       = $('send-btn');
const responsePane  = $('response-pane');
const newChatBtn    = $('new-chat-btn');
const statusLine    = $('status-line');
const charCount     = $('char-count');
const paramsToggle  = $('params-toggle');
const paramsPanel   = $('params-panel');
const paramNumCtx   = $('param-num-ctx');
const paramTemp     = $('param-temperature');
const paramPredict  = $('param-num-predict');
const paramThink    = $('param-thinking');
const paramTools    = $('param-tools');
const toolsInfo     = $('tools-info');
const paramToolLimit = $('param-tool-limit');
const serversGroup  = $('servers-group');
const serversBox    = $('servers-box');
const ctxMeter      = $('ctx-meter');

let currentAbort    = null;      // AbortController for the request in flight (Stop button)

// ── Saved settings (localStorage; harmless if unavailable) ─────
const SETTINGS_KEY = 'harness-settings';
const settingInputs = () => ({
  num_ctx: paramNumCtx, temperature: paramTemp, num_predict: paramPredict,
  think: paramThink, tools: paramTools, toolLimit: paramToolLimit,
});

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}

function saveSettings() {
  const s = { model: modelSelect.value, disabledServers: disabledServers() };
  for (const [k, el] of Object.entries(settingInputs())) s[k] = el.value;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

function applySettings(s) {
  for (const [k, el] of Object.entries(settingInputs())) if (s[k] !== undefined) el.value = s[k];
}

const disabledServers = () =>
  [...serversBox.querySelectorAll('input[type=checkbox]')].filter(c => !c.checked).map(c => c.value);

// ── Init ────────────────────────────────────────────────────────
//This next line is similar to doing an onload.  I'm replacing it with an onload in the body
//so that I'm sure of what's going on.  Note that you would have to close the EventListener at the end 
//of this function if you did it this way.
//document.addEventListener('DOMContentLoaded', async () => {

async function init(){
  addFilesBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => {
    Array.from(e.target.files).forEach(addFile);
    fileInput.value = '';
  });

  // The Send button turns into Stop while a reply is running.
  sendBtn.addEventListener('click', () => isSending ? stopSending() : sendMessage());
  promptInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !isSending) sendMessage();
  });
  newChatBtn.addEventListener('click', newConversation);

  // Parameters toggle
  paramsToggle.addEventListener('click', () => {
    const isOpen = !paramsPanel.hidden;
    paramsPanel.hidden = isOpen;
    paramsToggle.textContent = isOpen ? '⚙ Parameters' : '⚙ Parameters ▲';
  });

  // drag & drop
  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    Array.from(e.dataTransfer.files).forEach(addFile);
  });

  // live char count
  promptInput.addEventListener('input', updateCharCount);

  // Settings persist between visits
  const saved = loadSettings();
  applySettings(saved);
  for (const el of Object.values(settingInputs())) el.addEventListener('change', saveSettings);
  modelSelect.addEventListener('change', saveSettings);

  await loadModels(saved.model);
  await loadTools(saved.disabledServers || []);
  renderFileTray();
};

// ── MCP tools (started by server.js from mcp.json) ─────────────
async function loadTools(savedDisabled = []) {
  try {
    const r = await fetch('/api/tools');
    const tools = await r.json();
    if (!tools.length) {
      toolsInfo.textContent = 'none configured';
      paramTools.value = 'off';
      paramTools.disabled = true;
      return;
    }
    const servers = [...new Set(tools.map(t => t.server))];
    toolsInfo.textContent = `${tools.length} tools`;
    toolsInfo.title = tools
      .map(t => `${t.autoApprove ? '  ' : '✋'} ${t.name}  (${t.server})`)
      .join('\n') + '\n\n✋ = asks before running';

    // One checkbox per server; unticked servers' tools aren't offered to the model.
    serversBox.innerHTML = servers.map(s => {
      const n = tools.filter(t => t.server === s).length;
      return `<label class="server-toggle" title="${n} tools">
        <input type="checkbox" value="${esc(s)}" ${savedDisabled.includes(s) ? '' : 'checked'}> ${esc(s)}
      </label>`;
    }).join('');
    serversBox.addEventListener('change', saveSettings);
    serversGroup.hidden = false;
  } catch {
    toolsInfo.textContent = 'unavailable';
  }
}

// ── Context meter ───────────────────────────────────────────────
function updateCtxMeter(used, numCtx) {
  if (!used || !numCtx) return;
  const pct = Math.round(100 * used / numCtx);
  ctxMeter.textContent = `Context ${used.toLocaleString()} / ${numCtx.toLocaleString()} tokens (${pct}%)`;
  ctxMeter.classList.toggle('ctx-warn', pct >= 85 && pct < 100);
  ctxMeter.classList.toggle('ctx-full', pct >= 100);
}

//.............................................................................

// ── Models ──────────────────────────────────────────────────────
async function loadModels(savedModel) {
  //Pick up the list of available models and put them in a drop-down list.
  try {
    const r = await fetch('/api/models');
    const models = await r.json();
    if (!Array.isArray(models) || models.length === 0)
      throw new Error('No models found. Is `ollama pull` done?');
    modelSelect.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
    // Last-used model if it's still installed, otherwise the preferred default.
    var useIndex = models.indexOf(savedModel);
    if (useIndex === -1) useIndex = models.indexOf("qwen3.8:27b");
    if (useIndex !== -1) modelSelect.selectedIndex = useIndex;
  } catch (err) {
    statusLine.textContent = err.message;
    statusLine.classList.add('status-error');
  }
}

//.............................................................................

function renderFileTray() {
  if (selectedFiles.length === 0) {
    fileList.innerHTML = '<div class="empty-hint">Drop files here or click "+ Add Files"</div>';
    return;
  }
  fileList.innerHTML = selectedFiles.map((f, i) => `
    <div class="file-item">
      <span class="file-name">${esc(f.name)}</span>
      <span class="file-lines">${f.lines}L${f.label === 'docx' ? ' · docx' : f.label === 'pdf' ? ' · pdf' : ''}</span>
      <button class="file-remove" onclick="removeFile(${i})" title="Remove">✕</button>
    </div>`).join('');
}

//...............................................................................

// ── File handling ───────────────────────────────────────────────
async function addFile(file) {
  if (selectedFiles.some(f => f.name === file.name)) return;

  const ext = file.name.split('.').pop().toLowerCase();
  let content, label;

  if (ext === 'docx') {
    ({ content, label } = await readDocx(file));
  } else if (ext === 'pdf') {
    ({ content, label } = await readPdf(file));
  } else {
    // text, code, markdown, csv, json, …
    content = await file.text();
    label   = ext;
  }

  const lines = content.split('\n').length;
  selectedFiles.push({ name: file.name, content, lines, label });
  renderFileTray();
  updateCharCount();
}

// ── .docx via mammoth ──────────────────────────────────────────
async function readDocx(file) {
  const arrayBuffer = await file.arrayBuffer();
  // mammoth.browser exposes a global `mammoth` when loaded via <script>.
  // If you use dynamic import instead:
  //   const mammoth = await import('mammoth/mammoth.browser.js');
  const result = await mammoth.convertToHtml({ arrayBuffer });

  // result.value is HTML like:
  //   <p>…</p><h2>…</h2><table>…</table>…
  // That structure is *useful* to the LLM – keep it.
  return {
    content: result.value.trim(),
    label:   'docx',
    warnings: result.messages.map(m => m.message),   // optional: log/flag
  };
}

// ── .pdf via pdf.js ────────────────────────────────────────────
async function readPdf(file) {
  const arrayBuffer = await file.arrayBuffer();

  // Dynamic import so pdf.js only loads when a PDF is actually dropped.
  const pdfjsLib = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.min.mjs');

  // pdf.js 4.x needs a worker. Point it at the same CDN.
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs';

  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page      = await pdf.getPage(i);
    const textContent = await page.getTextContent();

    // Reconstruct lines from the item array.
    // Items carry .str and .hasEOL (end-of-line flag).
    let line = '';
    let pageText = '';
    for (const item of textContent.items) {
      if (item.str === undefined) continue;   // skip spacing gaps
      line += item.str;
      if (item.hasEOL) {
        pageText += line + '\n';
        line = '';
      }
    }
    if (line) pageText += line;               // last line w/o EOL
    pages.push(`--- Page ${i} ---\n${pageText.trim()}`);
  }

  return {
    content: pages.join('\n\n'),
    label:   'pdf',
  };
}

function removeFile(i) {
  selectedFiles.splice(i, 1);
  renderFileTray();
  updateCharCount();
}

//.......................................................................................

// ── Build the API message ───────────────────────────────────────
function buildApiContent() {
  let out = '';
  for (const f of selectedFiles) {
    const isCodeLike = !['docx', 'pdf', 'html'].includes(f.label);
    if (isCodeLike) {
      out += `### File: ${f.name} (${f.lines} lines)\n\`\`\`${f.label}\n${f.content}\n\`\`\`\n\n`;
    } else {
      // No code fence – the content is already structured (HTML / paged text).
      out += `### Document: ${f.name} (${f.lines} lines)\n${f.content}\n\n`;
    }
  }
  const prompt = promptInput.value.trim();
  if (prompt) out += prompt;
  return out;
}

function buildDisplaySummary() {
  let html = '';
  if (selectedFiles.length) {
    const names = selectedFiles.map(f => `${f.name} (${f.lines}L)`).join(', ');
    html += `<div class="files-sent">📎 ${esc(names)}</div>`;
  }
  const prompt = promptInput.value.trim();
  if (prompt) html += `<p>${esc(prompt)}</p>`;
  return html || '<p>(empty)</p>';
}

// ── Parameters ──────────────────────────────────────────────────
function toNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function getOllamaOptions() {
  return {
    num_ctx:     toNum(paramNumCtx.value,  32768),
    temperature: toNum(paramTemp.value,    0.7),
    num_predict: toNum(paramPredict.value, 4096),
  };
}

//....................................................................................

// ── Send ────────────────────────────────────────────────────────
async function sendMessage() {
  if (isSending) return;
  const content = buildApiContent();
  if (!content.trim()) { statusLine.textContent = 'Nothing to send.'; return; }

  isSending = true;
  currentAbort = new AbortController();
  sendBtn.textContent = 'Stop';
  sendBtn.classList.add('btn-stop');
  statusLine.textContent = 'Thinking…';
  statusLine.classList.remove('status-error');

  appendMsg('user', buildDisplaySummary());
  messages.push({ role: 'user', content });
  let shell = null;                        // the assistant message being built

  try {
    var thinkVal = paramThink.value;
    if (thinkVal.toLowerCase()=="true") thinkVal = true;
    else if (thinkVal.toLowerCase()=="false") thinkVal = false;
    const r = await fetch('/api/chat', {
      method: 'POST',
      signal: currentAbort.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:   modelSelect.value,
        messages,
        options: getOllamaOptions(),
        think:thinkVal,
        useTools: paramTools.value === 'on',
        toolResultLimit: toNum(paramToolLimit.value, 8000),
        disabledServers: disabledServers()
      }),
    });

    if (!r.ok) {
      const errBody = await r.json().catch(() => ({}));
      throw new Error(errBody.error || r.statusText);
    }

    // ── Build the assistant message shell up front ──────────────
    const msgDiv   = createMsgShell('assistant');
    shell = msgDiv;
    const thinkWrap = msgDiv.querySelector('.thinking-block');
    const thinkSum  = thinkWrap.querySelector('summary');
    const thinkBody = thinkWrap.querySelector('.thinking-content');
    const bodyDiv   = msgDiv.querySelector('.msg-body');
    thinkWrap.hidden = false;          // show the (empty) thinking block immediately
    thinkSum.textContent = '💭 Thinking…';

    // ── Read the NDJSON stream ──────────────────────────────────
    const reader    = r.body.getReader();
    const decoder   = new TextDecoder();
    let buffer      = '';
    let thinking    = '';
    let reply       = '';
    let thinkOpen   = true;            // keep <details> open while streaming

    // The reply body is a sequence of segments: text, tool call, text, …
    // `segText`/`segDiv` is the text segment currently being written.
    let segText     = '';
    let segDiv      = null;
    let turnMessages = null;           // history additions sent by the server at the end
    const toolDivs  = {};              // tool call id → its block
    let usageEstimate = 0, usageCtx = 0;   // our estimate of the request size, from the server

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process every complete line; keep the partial one in `buffer`.
      const lines  = buffer.split('\n');
      buffer       = lines.pop();      // last element may be incomplete
      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line);

        // ── Harness events (tools etc.) ──
        if (chunk.type === 'tool_call') {
          segDiv = null; segText = '';             // text after the tool starts a new segment
          toolDivs[chunk.id] = appendToolBlock(bodyDiv, chunk);
          statusLine.textContent = chunk.needsApproval
            ? `Waiting for your approval: ${chunk.name}`
            : `Running ${chunk.name}…`;
          continue;
        }
        if (chunk.type === 'tool_result') {
          finishToolBlock(toolDivs[chunk.id], chunk);
          statusLine.textContent = 'Thinking…';
          continue;
        }
        if (chunk.type === 'notice') { statusLine.textContent = chunk.text; continue; }
        if (chunk.type === 'error')  throw new Error(chunk.text);
        if (chunk.type === 'turn')   { turnMessages = chunk.messages; continue; }
        if (chunk.type === 'usage')  { usageEstimate = chunk.estimate; usageCtx = chunk.numCtx; continue; }

        // ── Ollama chunks ──
        const msg   = chunk.message;
        if (!msg) continue;

        if (msg.thinking) {
          thinking += msg.thinking;
          thinkBody.textContent = thinking;
          thinkSum.textContent  = `💭 Thinking (${thinking.length.toLocaleString()} chars)`;
          if (thinkOpen) thinkWrap.open = true;
        }

        if (msg.content) {
          // First content token → close the thinking block
          if (thinkOpen) {
            thinkOpen = false;
            thinkWrap.open = false;
          }
          reply   += msg.content;
          segText += msg.content;
          if (!segDiv) {
            segDiv = document.createElement('div');
            bodyDiv.appendChild(segDiv);
          }
          segDiv.innerHTML = mdToHtml(segText);
          responsePane.scrollTop = responsePane.scrollHeight;
        }

        if (chunk.done) {
          // Final housekeeping
          thinkSum.textContent = `💭 Thinking (${thinking.length.toLocaleString()} chars)`;
          // Ollama's own token counts; with prompt caching they can under-report,
          // so show whichever is larger: theirs or our estimate.
          const used = Math.max((chunk.prompt_eval_count || 0) + (chunk.eval_count || 0), usageEstimate);
          updateCtxMeter(used, usageCtx || toNum(paramNumCtx.value, 32768));
        }
      }
    }

    // ── Finalize ────────────────────────────────────────────────
    if (!reply.trim() && !Object.keys(toolDivs).length) bodyDiv.innerHTML = '<p>(empty response)</p>';
    if (!thinking)     thinkWrap.hidden = true;   // hide if model didn't think

    // With tools, the server sends the exact messages this turn added
    // (tool calls + results + final answer) so the next turn has the full history.
    if (turnMessages) messages.push(...turnMessages);
    else              messages.push({ role: 'assistant', content: reply, thinking });

    selectedFiles = [];
    renderFileTray();
    promptInput.value = '';
    updateCharCount();
    statusLine.textContent = 'Done.';

  } catch (err) {
    messages.pop();                        // forget this exchange; the history stays consistent
    const tw = shell?.querySelector('.thinking-block');
    if (tw && !tw.querySelector('.thinking-content').textContent) tw.hidden = true;
    if (err.name === 'AbortError') {
      statusLine.textContent = 'Stopped. That exchange was not kept in the conversation.';
      shell?.classList.add('msg-stopped');
    } else {
      statusLine.textContent = err.message;
      statusLine.classList.add('status-error');
    }
  } finally {
    isSending = false;
    currentAbort = null;
    sendBtn.textContent = 'Send';
    sendBtn.classList.remove('btn-stop');
  }
}

// ── Tool call blocks ────────────────────────────────────────────
function appendToolBlock(container, call) {
  const wrap = document.createElement('div');
  wrap.className = 'tool-block running';
  const argsText = JSON.stringify(call.args ?? {}, null, 2);
  wrap.innerHTML = `
    <details ${call.needsApproval ? 'open' : ''}>
      <summary>
        <span class="tool-icon">🔧</span>
        <span class="tool-name">${esc(call.name)}</span>
        ${call.server ? `<span class="tool-server">${esc(call.server)}</span>` : ''}
        <span class="tool-status">${call.needsApproval ? 'needs approval' : 'running…'}</span>
      </summary>
      <div class="tool-detail">
        <div class="tool-label">Arguments</div>
        <pre>${esc(argsText)}</pre>
        <div class="tool-result-wrap" hidden>
          <div class="tool-label">Result</div>
          <pre class="tool-result"></pre>
        </div>
      </div>
    </details>`;

  if (call.needsApproval) {
    const bar = document.createElement('div');
    bar.className = 'tool-approval';
    bar.innerHTML = `
      <span>Allow this?</span>
      <button class="btn">Approve</button>
      <button class="btn btn-outline">Deny</button>`;
    const [approveBtn, denyBtn] = bar.querySelectorAll('button');
    const answer = async approved => {
      approveBtn.disabled = denyBtn.disabled = true;
      bar.querySelector('span').textContent = approved ? 'Approved' : 'Denied';
      try {
        const r = await fetch('/api/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: call.id, approved }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
        wrap.querySelector('.tool-status').textContent = approved ? 'running…' : 'denied';
      } catch (err) {
        bar.querySelector('span').textContent = `Couldn't send answer: ${err.message}`;
      }
    };
    approveBtn.addEventListener('click', () => answer(true));
    denyBtn.addEventListener('click',    () => answer(false));
    wrap.appendChild(bar);
  }

  container.appendChild(wrap);
  responsePane.scrollTop = responsePane.scrollHeight;
  return wrap;
}

function finishToolBlock(wrap, result) {
  if (!wrap) return;
  wrap.classList.remove('running');
  wrap.classList.add(result.ok ? 'ok' : 'failed');
  wrap.querySelector('.tool-approval')?.remove();
  wrap.querySelector('.tool-status').textContent = result.ok ? 'done' : 'failed';
  wrap.querySelector('.tool-result').textContent = result.text;
  wrap.querySelector('.tool-result-wrap').hidden = false;
  wrap.querySelector('details').open = false;
}

function stopSending() {
  currentAbort?.abort();
}

// ── Chat pane ───────────────────────────────────────────────────
function appendMsg(role, html,thinking) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;

    let thinkingHtml = '';
  if (thinking) {
    thinkingHtml = `
      <details class="thinking-block">
        <summary>💭 Thinking (${thinking.length.toLocaleString()} chars)</summary>
        <div class="thinking-content">${esc(thinking)}</div>
      </details>`;
  }
  
  div.innerHTML =
    `<div class="msg-label">${role === 'user' ? 'You' : 'Assistant'}</div>
    ${thinkingHtml}
    <div class="msg-body">${html}</div>`;
  responsePane.appendChild(div);
  responsePane.scrollTop = responsePane.scrollHeight;
}

function createMsgShell(role) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `
    <div class="msg-label">${role === 'user' ? 'You' : 'Assistant'}</div>
    <details class="thinking-block" open>
      <summary>💭 Thinking…</summary>
      <div class="thinking-content"></div>
    </details>
    <div class="msg-body"></div>`;
  responsePane.appendChild(div);
  responsePane.scrollTop = responsePane.scrollHeight;
  return div;
}

function newConversation() {
  if (isSending) stopSending();
  messages = [];
  ctxMeter.textContent = '';
  selectedFiles = [];
  promptInput.value = '';
  responsePane.innerHTML = '';
  renderFileTray();
  updateCharCount();
  statusLine.textContent = 'New conversation.';
  statusLine.classList.remove('status-error');
}

// ── Status helpers ──────────────────────────────────────────────
function updateCharCount() {
  const n = buildApiContent().length;
  charCount.textContent = `${n.toLocaleString()} chars in next request`;
}

// ── Tiny markdown → HTML (code blocks, bold, inline code, lists) ─
function mdToHtml(text) {
  const parts = [];
  let last = 0;
  const re = /```(\w*)\n?([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(inline(text.slice(last, m.index)));
    const lang = m[1] || '';
    parts.push(`<pre class="code-block"><code${lang ? ` data-lang="${lang}"` : ''}>${esc(m[2].replace(/\n$/, ''))}</code></pre>`);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(inline(text.slice(last)));
  return parts.join('') || esc(text);
}

function inline(t) {
  let h = esc(t);
  h = h.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  h = h.replace(/^[\s]*[-•]\s+(.+)/gm, '<li>$1</li>');
  h = h.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');
  h = h.replace(/\n\n+/g, '</p><p>');
  h = h.replace(/\n/g, '<br>');
  h = h.replace(/(?:<li>[\s\S]*?<\/li>\s*)+/g, m => `<ul>${m.trim()}</ul>`);
  if (h.trim() && !h.startsWith('<')) h = `<p>${h}</p>`;
  return h;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}