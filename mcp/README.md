# Spool MCP server

Lets Claude Code, Cursor or any MCP client read your Spool recordings: what you said, the steps you showed, a brief to work from.

```bash
# from a checkout (needs `npm install` once)
claude mcp add spool -- node /absolute/path/to/spool/mcp/server.js

# from the packaged app
claude mcp add spool -- node /Applications/Spool.app/Contents/Resources/app/mcp/server.js
```

| Tool | What it returns |
|---|---|
| `list_videos` | Recent recordings: id, title, length, whether the Privacy Guard cleared them |
| `search_videos` | Titles, summaries, tags and transcripts that match, with timestamped quotes |
| `get_transcript` | The full timestamped transcript (spoken secrets already bleeped) |
| `get_guide` | The Auto-Guide: numbered steps, timestamps, screenshot file paths |
| `get_action_plan` | A brief for a coding agent: what was asked, steps shown, click positions, transcript |

Then ask your agent: *"List my Spool videos and turn the latest one into a fix."*

**Rules it follows**
- Read-only. It reads `db.json` from the library folder and never writes, so it works with Spool closed.
- Local only: stdio, no network, no account.
- Only videos the Privacy Guard has cleared are readable. A video still being checked, or one whose check failed, returns an error instead of its content, and search never matches it.
- The library is found at `~/Library/Application Support/Spool/library` (macOS). Set `SPOOL_DATA` to point somewhere else.
