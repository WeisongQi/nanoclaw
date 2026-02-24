/**
 * NanoClaw Agent Runner (OpenCode SDK version)
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted.
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { createOpencode } from '@opencode-ai/sdk';
import type { Session } from '@opencode-ai/sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// ─── IPC helpers (unchanged from original) ───

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

// ─── Transcript archiving (replaces PreCompact hook) ───

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Archive conversation messages to /workspace/group/conversations/.
 * Replaces the old PreCompact hook — called explicitly after session completes.
 */
function archiveConversation(
  messages: ParsedMessage[],
  assistantName?: string,
  summary?: string,
): void {
  if (messages.length === 0) return;

  try {
    const name = summary ? sanitizeFilename(summary) : generateFallbackName();
    const conversationsDir = '/workspace/group/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}-${name}.md`;
    const filePath = path.join(conversationsDir, filename);

    const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
    fs.writeFileSync(filePath, markdown);
    log(`Archived conversation to ${filePath}`);
  } catch (err) {
    log(`Failed to archive conversation: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── OpenCode SDK integration ───

/**
 * Generate the opencode.json config for this container run.
 * Written to /workspace/group/opencode.json so the OpenCode server picks it up.
 */
function writeOpencodeConfig(containerInput: ContainerInput, mcpServerPath: string): void {
  const model = process.env.OPENCODE_MODEL || 'nvidia/moonshotai/kimi-k2.5';
  const baseURL = process.env.NVIDIA_API_BASE_URL || 'https://integrate.api.nvidia.com/v1';
  const apiKey = containerInput.secrets?.['NVIDIA_API_KEY'] || process.env.NVIDIA_API_KEY || '';

  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      nvidia: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Nvidia API',
        options: {
          baseURL,
          apiKey,
        },
        models: {
          'moonshotai/kimi-k2.5': {
            name: 'Kimi K2.5',
          },
        },
      },
    },
    model,
    mcp: {
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        },
      },
    },
  };

  const configPath = path.join('/workspace/group', 'opencode.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  log(`Wrote opencode.json to ${configPath}`);
}

/**
 * Build the system context prompt that gets injected via session.prompt({ noReply }).
 * Replaces the old globalClaudeMd + systemPrompt mechanism.
 */
function buildSystemContext(containerInput: ContainerInput): string | null {
  const parts: string[] = [];

  // Load global CLAUDE.md / AGENTS.md as additional system context
  // (shared across all groups, only for non-main groups)
  const globalContextPaths = [
    '/workspace/global/AGENTS.md',
    '/workspace/global/CLAUDE.md',
  ];

  // Load global context (shared across all groups)
  for (const ctxPath of globalContextPaths) {
    if (fs.existsSync(ctxPath)) {
      parts.push(fs.readFileSync(ctxPath, 'utf-8'));
      break; // use the first one found
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * Extract text content from an OpenCode AssistantMessage response.
 */
function extractResultText(result: Record<string, unknown>): string | null {
  // The result from session.prompt() contains info and parts
  const info = result?.info as Record<string, unknown> | undefined;
  const parts = result?.parts as Array<Record<string, unknown>> | undefined;

  if (parts && Array.isArray(parts)) {
    const textParts = parts
      .filter(p => p.type === 'text')
      .map(p => p.text as string)
      .filter(Boolean);
    if (textParts.length > 0) return textParts.join('');
  }

  // Fallback: check info for structured output
  if (info?.structured_output) {
    return JSON.stringify(info.structured_output);
  }

  return null;
}

/**
 * Run a single query against OpenCode and stream results via writeOutput.
 */
async function runQuery(
  client: ReturnType<typeof import('@opencode-ai/sdk').createOpencodeClient>,
  sessionId: string,
  prompt: string,
  containerInput: ContainerInput,
): Promise<{ closedDuringQuery: boolean }> {
  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;

  const pollIpcDuringQuery = async () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, aborting');
      closedDuringQuery = true;
      // Abort the running session
      try {
        await client.session.abort({ path: { id: sessionId } });
      } catch { /* best effort */ }
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    if (messages.length > 0) {
      // Send follow-up messages into the same session
      for (const text of messages) {
        log(`Piping IPC message into active session (${text.length} chars)`);
        try {
          // Queue follow-up message (noReply so it doesn't trigger a separate response)
          await client.session.prompt({
            path: { id: sessionId },
            body: {
              parts: [{ type: 'text', text }],
              noReply: true,
            },
          });
        } catch (err) {
          log(`Failed to pipe IPC message: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (ipcPolling) setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  try {
    log(`Sending prompt to session ${sessionId} (${prompt.length} chars)`);

    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text: prompt }],
      },
    });

    ipcPolling = false;

    if (result.data) {
      const text = extractResultText(result.data as Record<string, unknown>);
      log(`Got response: ${text ? text.slice(0, 200) : '(empty)'}`);
      writeOutput({
        status: 'success',
        result: text,
        newSessionId: sessionId,
      });
    } else if (result.error) {
      log(`Prompt error: ${JSON.stringify(result.error)}`);
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: sessionId,
        error: JSON.stringify(result.error),
      });
    }
  } catch (err) {
    ipcPolling = false;
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Query error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
  }

  return { closedDuringQuery };
}

// ─── Main ───

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  // Write opencode.json for this container run
  writeOpencodeConfig(containerInput, mcpServerPath);

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Start OpenCode server in-process (Plan B)
  log('Starting OpenCode server...');
  const opencode = await createOpencode({
    hostname: '127.0.0.1',
    port: 0, // auto-assign port
    config: {
      model: process.env.OPENCODE_MODEL || 'nvidia/moonshotai/kimi-k2.5',
    },
  });
  const client = opencode.client;
  log(`OpenCode server running at ${opencode.server.url}`);

  // Create or resume a session
  let sessionId = containerInput.sessionId;
  let session: Session | undefined;

  if (sessionId) {
    // Try to resume existing session
    try {
      const existing = await client.session.get({ path: { id: sessionId } });
      if (existing.data) {
        session = existing.data;
        log(`Resumed existing session: ${sessionId}`);
      }
    } catch {
      log(`Could not resume session ${sessionId}, creating new one`);
      sessionId = undefined;
    }
  }

  if (!session) {
    const created = await client.session.create({
      body: { title: `nanoclaw-${containerInput.groupFolder}` },
    });
    session = created.data!;
    sessionId = session.id;
    log(`Created new session: ${sessionId}`);
  }

  // Inject system context (global AGENTS.md / CLAUDE.md) without triggering a response
  const systemContext = buildSystemContext(containerInput);
  if (systemContext) {
    log('Injecting system context into session...');
    await client.session.prompt({
      path: { id: sessionId },
      body: {
        noReply: true,
        parts: [{ type: 'text', text: systemContext }],
      },
    });
  }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Collect messages for archiving
  const conversationMessages: ParsedMessage[] = [];

  // Query loop: run query → wait for IPC message → run new query → repeat
  try {
    while (true) {
      log(`Starting query (session: ${sessionId})...`);

      // Track the user message
      conversationMessages.push({ role: 'user', content: prompt });

      const queryResult = await runQuery(client, sessionId, prompt, containerInput);

      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
  }

  // Archive the conversation before shutting down
  archiveConversation(conversationMessages, containerInput.assistantName);

  // Clean up OpenCode server
  log('Shutting down OpenCode server...');
  opencode.server.close();
}

main();
