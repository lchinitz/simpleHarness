const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');

const app = express();
const PORT = 3456;
const HOST = '127.0.0.1';          // this machine only — the tools can send email as you
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MCP_CONFIG = path.join(__dirname, 'mcp.json');

const MAX_TOOL_ROUNDS     = 10;               // model ↔ tool round trips per message
const DEFAULT_RESULT_LIMIT = 8000;            // chars of tool output passed back to the model
const DEFAULT_NUM_CTX     = 32768;
const CHARS_PER_TOKEN     = 3.5;              // rough estimate; real tokenizers vary
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;    // unanswered approval → denied
// Tools whose names start like this run without asking (read-only by convention).
// Override per server with "autoApprove": [ ...tool names... ] in mcp.json.
const DEFAULT_AUTO_APPROVE = /^(get|list|search|find|read)_/;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

/* ── MCP: start servers from mcp.json, collect their tools ──────── */

const mcpTools = new Map();   // tool name → { server, client, name, description, inputSchema, auto }

async function startMcpServers() {
  if (!fs.existsSync(MCP_CONFIG)) {
    console.log('  MCP                 →  no mcp.json found, tools disabled');
    return;
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(MCP_CONFIG, 'utf8'));
  } catch (err) {
    console.error(`  MCP                 →  mcp.json is not valid JSON: ${err.message}`);
    return;
  }

  for (const [serverName, s] of Object.entries(config.mcpServers || {})) {
    if (s.disabled) continue;
    try {
      const transport = new StdioClientTransport({
        command: s.command,
        args: s.args || [],
        env: { ...getDefaultEnvironment(), ...(s.env || {}) },
        cwd: s.cwd,
        stderr: 'pipe',
      });
      // MCP servers log to stderr; show it here, labelled.
      transport.stderr?.on('data', d =>
        String(d).trimEnd().split('\n').forEach(l => console.error(`  [${serverName}] ${l}`)));

      const client = new Client({ name: 'llm-coding-harness', version: '1.0.0' });
      await client.connect(transport);
      const { tools } = await client.listTools();

      for (const t of tools) {
        // If two servers expose the same tool name, prefix the later one.
        const key = mcpTools.has(t.name) ? `${serverName}__${t.name}` : t.name;
        mcpTools.set(key, {
          server: serverName,
          client,
          name: t.name,
          description: t.description || '',
          inputSchema: t.inputSchema || { type: 'object', properties: {} },
          auto: Array.isArray(s.autoApprove)
            ? s.autoApprove.includes(t.name)
            : DEFAULT_AUTO_APPROVE.test(t.name),
        });
      }
      console.log(`  MCP ${serverName.padEnd(16)}→  ${tools.length} tools`);
    } catch (err) {
      console.error(`  MCP ${serverName.padEnd(16)}→  failed to start: ${err.message}`);
    }
  }
}

// MCP tool list → Ollama's "tools" format, minus servers switched off in the browser
function ollamaTools(disabledServers = []) {
  return [...mcpTools.entries()]
    .filter(([, t]) => !disabledServers.includes(t.server))
    .map(([key, t]) => ({
    type: 'function',
    function: { name: key, description: t.description, parameters: t.inputSchema },
  }));
}

async function runTool(key, args) {
  const t = mcpTools.get(key);
  if (!t) return { ok: false, text: `Unknown tool: ${key}` };
  try {
    const r = await t.client.callTool({ name: t.name, arguments: args });
    const text = (r.content || [])
      .map(c => (c.type === 'text' ? c.text : `[${c.type} content not shown]`))
      .join('\n');
    return { ok: !r.isError, text: text || '(no output)' };
  } catch (err) {
    return { ok: false, text: `Error: ${err.message}` };
  }
}

/* ── Approvals: the browser answers via POST /api/approve ───────── */

const pendingApprovals = new Map();   // id → resolve(boolean)

function waitForApproval(id, signal) {
  return new Promise(resolve => {
    const finish = ok => {
      clearTimeout(timer);
      pendingApprovals.delete(id);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS);
    pendingApprovals.set(id, finish);
    signal.addEventListener('abort', () => finish(false), { once: true });
  });
}

app.post('/api/approve', (req, res) => {
  const finish = pendingApprovals.get(req.body.id);
  if (!finish) return res.status(404).json({ error: 'No pending approval with that id (it may have timed out).' });
  finish(req.body.approved === true);
  res.json({ ok: true });
});

/* ── API routes ───────────────────────────────────────────────────── */

app.get('/api/models', async (_req, res) => {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = await r.json();
    res.json((data.models || []).map(m => m.name));
  } catch (err) {
    res.status(502).json({ error: `Cannot reach Ollama at ${OLLAMA_URL}: ${err.message}` });
  }
});

app.get('/api/tools', (_req, res) => {
  res.json([...mcpTools.entries()].map(([key, t]) => ({
    name: key, server: t.server, description: t.description, autoApprove: t.auto,
  })));
});

// Split a streamed response body into NDJSON lines.
async function* ndjsonLines(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) yield line;
  }
  if (buffer.trim()) yield buffer;
}

/* ── Context budget ─────────────────────────────────────────────
   Ollama silently drops the OLDEST messages when a request doesn't fit
   in num_ctx — which can be the user's question. Qwen3's template then
   fails with "No user query found in messages". So we estimate the size
   ourselves and shrink old tool results / old thinking first.          */

const estimateTokens = (messages, tools) =>
  Math.ceil((JSON.stringify(messages).length + (tools ? JSON.stringify(tools).length : 0)) / CHARS_PER_TOKEN);

// Room for the prompt: num_ctx minus what we leave for the reply.
function promptBudget(options) {
  const numCtx = Number(options?.num_ctx) || DEFAULT_NUM_CTX;
  const reserve = Math.min(Number(options?.num_predict) || 4096, Math.floor(numCtx / 4));
  return { numCtx, budget: numCtx - reserve };
}

// Returns a trimmed copy; never touches user messages or the model's answers.
function fitToBudget(messages, tools, budget) {
  const out = messages.map(m => ({ ...m }));
  let trimmed = 0;
  let size = estimateTokens(out, tools);
  if (size <= budget) return { messages: out, trimmed, size };

  // 1. Thinking from earlier turns is never needed again.
  const lastUser = out.map(m => m.role).lastIndexOf('user');
  for (let i = 0; i < lastUser; i++) {
    if (out[i].role === 'assistant' && out[i].thinking) delete out[i].thinking;
  }
  size = estimateTokens(out, tools);

  // 2. Oldest tool results first.
  for (let i = 0; i < out.length && size > budget; i++) {
    const m = out[i];
    if (m.role !== 'tool' || m.content.startsWith('[earlier result trimmed')) continue;
    m.content = `[earlier result trimmed to save context: was ${m.content.length.toLocaleString()} chars]`;
    trimmed++;
    size = estimateTokens(out, tools);
  }
  return { messages: out, trimmed, size };
}

// Turn Ollama's errors into something a person can act on.
function friendlyError(message, numCtx) {
  if (/no user query found/i.test(message) || /context length|exceeds.*context/i.test(message)) {
    return `The conversation no longer fits in the ${numCtx.toLocaleString()}-token context window, ` +
           `so Ollama dropped the earliest messages, including your question. ` +
           `Start a New Chat, raise "Context window", or lower "Tool result limit".`;
  }
  return message;
}

/*
  /api/chat streams NDJSON back to the browser:
    - Ollama's own chunks, passed through unchanged ({ message: { content | thinking } , done, prompt_eval_count … })
    - { type: 'tool_call',   id, name, server, args, needsApproval }
    - { type: 'tool_result', id, name, ok, text }
    - { type: 'usage', estimate, numCtx }   our own size estimate of the last request
    - { type: 'notice', text }              e.g. "trimmed 2 older tool results"
    - { type: 'error',  text }
    - { type: 'turn', messages }            every message this turn added to the history
                                            (assistant tool_calls, tool results, final answer)
*/
app.post('/api/chat', async (req, res) => {
  const { model, messages, options, think, useTools, disabledServers = [] } = req.body;
  const resultLimit = Math.max(500, Number(req.body.toolResultLimit) || DEFAULT_RESULT_LIMIT);
  const { numCtx, budget } = promptBudget(options);

  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });   // browser went away / Stop

  const send = obj => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };
  const startStream = () => {
    if (res.headersSent) return;
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
  };

  let tools = useTools !== false && mcpTools.size ? ollamaTools(disabledServers) : null;
  if (tools && !tools.length) tools = null;
  const convo = [...messages];   // grows with tool calls/results during this turn
  const added = [];              // what this turn adds to the history
  let warnedFull = false;

  async function callOllama(round) {
    const sendTools = tools && round < MAX_TOOL_ROUNDS ? tools : null;   // last round: force an answer
    const fit = fitToBudget(convo, sendTools, budget);
    if (fit.trimmed) {
      startStream();
      send({ type: 'notice', text: `Trimmed ${fit.trimmed} older tool result${fit.trimmed > 1 ? 's' : ''} to fit the context window.` });
    }
    if (fit.size > budget && !warnedFull) {
      warnedFull = true;
      startStream();
      send({ type: 'notice', text: 'This conversation is at the context limit even after trimming. Consider a New Chat.' });
    }

    const body = { model, messages: fit.messages, stream: true, think };
    body.options = { ...(options && typeof options === 'object' ? options : {}), num_ctx: numCtx };
    if (sendTools) body.tools = sendTools;

    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    if (r.ok) {
      startStream();
      send({ type: 'usage', estimate: fit.size, numCtx });
      return r;
    }

    const errBody = await r.json().catch(() => ({}));
    const message = errBody.error || r.statusText;
    if (body.tools && /does not support tools/i.test(message)) {
      tools = null;
      startStream();
      send({ type: 'notice', text: `${model} can't use tools, so it answered without them.` });
      return callOllama(round);
    }
    const err = new Error(friendlyError(message, numCtx));
    err.status = r.status;
    throw err;
  }

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const r = await callOllama(round);

      let content = '', thinking = '';
      const toolCalls = [];
      for await (const line of ndjsonLines(r.body)) {
        const chunk = JSON.parse(line);
        if (chunk.error) throw new Error(friendlyError(chunk.error, numCtx));
        const m = chunk.message;
        if (m) {
          if (m.content)    content  += m.content;
          if (m.thinking)   thinking += m.thinking;
          if (m.tool_calls) toolCalls.push(...m.tool_calls);
        }
        send(chunk);
      }

      const assistantMsg = { role: 'assistant', content };
      if (thinking) assistantMsg.thinking = thinking;

      if (toolCalls.length === 0) {     // a plain answer: the turn is over
        added.push(assistantMsg);
        break;
      }

      assistantMsg.tool_calls = toolCalls;
      convo.push(assistantMsg);
      added.push(assistantMsg);

      for (const call of toolCalls) {
        const key = call.function?.name;
        let args = call.function?.arguments ?? {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }

        const tool = mcpTools.get(key);
        const offered = tool && !disabledServers.includes(tool.server);
        const needsApproval = Boolean(offered && !tool.auto);
        const id = crypto.randomUUID();
        send({ type: 'tool_call', id, name: key, server: tool?.server, args, needsApproval });

        let result;
        if (!offered) {
          result = { ok: false, text: `Tool "${key}" is not available.` };
        } else if (needsApproval && !(await waitForApproval(id, abort.signal))) {
          result = { ok: false, text: 'The user declined this tool call. Do not retry it unless asked.' };
        } else {
          result = await runTool(key, args);
        }
        if (abort.signal.aborted) return;

        send({ type: 'tool_result', id, name: key, ok: result.ok, text: result.text.slice(0, 4000) });

        let forModel = result.text;
        if (forModel.length > resultLimit)
          forModel = forModel.slice(0, resultLimit) +
            `\n…[cut at ${resultLimit.toLocaleString()} of ${result.text.length.toLocaleString()} chars]`;
        const toolMsg = { role: 'tool', tool_name: key, content: forModel };
        convo.push(toolMsg);
        added.push(toolMsg);
      }
    }

    send({ type: 'turn', messages: added });
    res.end();

  } catch (err) {
    if (abort.signal.aborted) return;
    if (!res.headersSent) {
      res.status(err.status || 502).json({ error: err.message });
    } else {
      send({ type: 'error', text: err.message });
      res.end();
    }
  }
});

/* ── Start ────────────────────────────────────────────────────── */

app.listen(PORT, HOST, async () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  LLM Coding Harness  →  ${url}`);
  console.log(`  Ollama target       →  ${OLLAMA_URL}`);
  await startMcpServers();
  console.log('');

  if (process.env.NO_BROWSER) return;
  const cmd =
    process.platform === 'win32' ? `start ${url}`
      : process.platform === 'darwin' ? `open ${url}`
        : `xdg-open ${url}`;
  exec(cmd);
});
