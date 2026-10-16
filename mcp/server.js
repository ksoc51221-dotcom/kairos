#!/usr/bin/env node
// Iris MCP server (stdio). Lets Claude Code, Cursor or any MCP client read your recordings: list and search them, and pull a transcript, a guide
// or an "action plan" brief into the conversation.
//   claude mcp add iris -- node /path/to/spool/mcp/server.js
// Read-only, local, no network. Only videos the Privacy Guard has cleared are readable. Logs go to stderr: stdout belongs to the protocol.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const lib = require('./lib');

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const json = (o) => text(JSON.stringify(o, null, 2));
const guard = (fn) => async (args) => { try { return await fn(args || {}); } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; } };

function build({ dir = lib.dataDir() } = {}) {
  const library = lib.libraryDir(dir);
  const server = new McpServer({ name: 'iris', version: '0.1.0' });
  const id = z.string().describe('The video id from list_videos');
  server.registerTool('list_videos', { title: 'List Iris videos', description: 'Lists recent Iris recordings, newest first, with id, title, length, and whether the Privacy Guard has cleared them (only cleared videos can be read).', inputSchema: { limit: z.number().int().min(1).max(200).optional().describe('How many (default 20)') } },
    guard(({ limit }) => json(lib.listVideos(library, { limit }))));
  server.registerTool('search_videos', { title: 'Search Iris videos', description: 'Searches titles, summaries, tags and transcripts of cleared recordings. Returns matching videos with up to three timestamped quotes.', inputSchema: { query: z.string().describe('Words to look for'), limit: z.number().int().min(1).max(50).optional() } },
    guard(({ query, limit }) => json(lib.searchVideos(library, query, { limit }))));
  server.registerTool('get_transcript', { title: 'Get a transcript', description: 'The full timestamped transcript of one recording. Spoken passwords and keys were already bleeped by the Privacy Guard.', inputSchema: { id } },
    guard(({ id }) => text(lib.transcript(library, id))));
  server.registerTool('get_guide', { title: 'Get the step-by-step guide', description: 'The Auto-Guide for one recording: numbered steps with timestamps and the file path of each screenshot.', inputSchema: { id } },
    guard(({ id }) => text(lib.guideMarkdown(library, id, dir ? lib.libraryDir(dir) : undefined))));
  server.registerTool('get_action_plan', { title: 'Get the action plan', description: 'A brief for a coding agent built from one recording: what was asked, the steps shown with screenshot paths and click positions, and the transcript.', inputSchema: { id } },
    guard(({ id }) => text(lib.actionPlan(library, id, lib.libraryDir(dir)))));
  return server;
}

if (require.main === module) {
  const server = build();
  server.connect(new StdioServerTransport()).then(() => console.error('iris mcp: ready, reading', lib.libraryDir()), (e) => { console.error('iris mcp failed:', e.message); process.exit(1); });
}
module.exports = { build };
