# Hermes: pitch, demo video and Q&A

Built from the judge's scorecard for Margin (62/100: video 25/40, repo 11/20, pitch 26/40). Each item below says which note it answers.

## What the judge said, and the fix

| Note | Fix |
|---|---|
| "No real hook" | Open on the problem in the first 15 s: a real secret on screen, then a stranger-proof fix. Script below |
| "Prepare a specific environment" | Demo on a clean desktop, a fake project with a fake `.env`, one monitor, notifications off, 1080p+ capture |
| "Really good UX, work on response versions" | Show Hermes answering in three forms from one recording: Action Plan, bug report, PR description. One click each |
| "No wow effect" | The wow is the round trip: record, say a fake password, then Claude Code fixes the bug from the recording while the secret is black-boxed and bleeped |
| "126 s instead of 90" | The script is 88 s at 150 words per minute. Time it with a stopwatch before recording |
| "Didn't mention the market/who needs it" | Slide 2 names users and the trigger: anyone who records a screen with work data on it |
| "How well did you implement agents" | Show the agent crew run (Planner, Guide Writer, Guide Critic fact-check loop) and the MCP call that hands the result to another agent |
| "Safety and different models" | Slide 5 and the README table: the model only sees redacted text, swap models in Settings, fail closed |
| "Delivery pace inconsistent, add energy" | Rehearse with the table at the bottom; one breath per beat |

## 90-second demo video (about 225 words)

| Time | On screen | Say |
|---|---|---|
| 0-12 | Screen with a fake API key and an e-mail visible, cursor hovering over Record | "Every screen recording you send leaks something. This key, this e-mail, the password you say out loud. Cloud recorders upload all of it." |
| 12-22 | Click Record for agent, talk through a bug, say "the password is hunter-two" | "So I built Hermes. I record a bug. I even say the password." |
| 22-35 | Stop. Library: owner can play after about 7 seconds. Then the viewer link: key and e-mail are solid black, audio bleeps | "Seven seconds later I can watch it. Anyone else only gets it after a local guard has covered every secret, on screen and in my voice. If the guard fails, nobody gets it." |
| 35-55 | AI Actions tab: Action Plan, then bug report, then PR description | "And the recording is not a dead end. One recording, three outputs. The Action Plan has what I said, the steps I showed and where I clicked." |
| 55-75 | Terminal: Claude Code calls `get_action_plan`, edits the file, test passes | "Now the part I care about. Claude Code reads that plan over MCP, finds the bug and fixes it. The agent never saw my secret." |
| 75-88 | README architecture diagram, 4 labels: local Whisper, Apple Vision, Ollama, solid black fill | "Everything is local: Whisper for speech, Apple Vision for the screen, any Ollama model for the writing. No account, no upload. Hermes." |

Technical callouts to show on screen as they happen (the "wow factor" the judge wanted): 60 fps native-resolution capture, one hardware encode, fail-closed viewer gate, 170+ unit tests and an end-to-end self-test on the real screen.

Capture rules: 1080p or better, one take per beat, record voice-over separately in a quiet room, cut dead air, end on the logo, hard stop at 90 s.

## Live pitch (3 minutes)

1. **Problem and stakes (45 s).** The trigger is a normal act: "let me record this for you". The cost is a leaked key or customer record, and the other cost is an agent that cannot use what you showed. Name three users: developers filing bugs, support/QA, and teams whose data cannot leave the building.
2. **Solution (45 s).** Live demo of the 88-second flow, no slides.
3. **Why now (30 s).** Local speech and vision models are good enough on a laptop, and coding agents now take MCP tools. A year ago neither was true.
4. **Agents and safety (30 s).** The crew, the critic loop, the model swap, fail-closed.
5. **Close (30 s).** "Record once, share safely, let an agent finish the job." Stop on the line.

Market size: I have no sourced number and will not invent one. The argument is bottom-up: every team that records screens and has a security policy is a customer, and local-first is the only way to satisfy that policy.

## Q&A defense (short, no fluff)

| Question | Answer |
|---|---|
| What if OCR misses a secret? | Real limit, stated in the README: the screen is sampled twice a second, an unchanged screen is read at least every 2 s, so a secret visible for under 2 s can fall between frames. Rules cover keys, tokens, e-mail, cards, SSNs, phones, passwords. |
| What if someone says a secret without a cue? | A bare "hunter2" can get through. Cues like "the password is", "my pin is", token-like words and runs of 9+ digits are caught. |
| Why not just blur it? | A blur can be reversed. Hermes uses a solid fill and deletes the unblurred file unless you ask to keep it. |
| Why local models? | The data is the problem. Sending screen text to an API to hide secrets defeats the point. |
| What breaks with a small or wrong model? | Output is schema-checked; junk is retried once, then the step is skipped. The Privacy Guard does not depend on the model: the rules run without it and the video says "rules-only check". |
| How do you know it works? | 170+ unit tests, plus an end-to-end test that records the real screen and checks the black box is in the published pixels (luma std 102 raw, 0 published). Owner can watch 6.9 s after Stop; viewers wait 18.1 s for the guard. |
| What is not done? | Not notarised, Apple silicon only, Send-to (Slack, GitHub, Linear, Jira) tested against local stubs not the real services, no window titles in the Action Plan. All listed under Limits in the README. |
| Can an agent be tricked by text in the video? | The Action Plan is data the agent reads. Treat it like any untrusted text; the MCP server is read-only and only serves cleared videos. |

## Delivery drill

- Say the hook line cold, 5 times, until it takes under 8 seconds.
- One idea per sentence. If a sentence has "and then", cut it in two.
- Pace: finish the 88-second demo in 85-90 s with a stopwatch, three runs in a row.
- Every team member owns one beat out loud: problem, demo, tech, close.
- Look at the judge, not the screen, on the closing line.
