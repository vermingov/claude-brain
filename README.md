# claude-brain

A local **second brain** for [Claude Code](https://claude.com/claude-code): your markdown
notes become persistent, searchable memory that Claude recalls before working and
records back into at the end of every session.

Everything runs on your machine. Your notes never leave your disk unless you connect
your own cloud account.

## Features

- **MCP server, and the only way in** — `claude-brain integrate` registers the brain as
  an MCP server: `recall` searches, `read` opens one note, `journal` writes the day's log,
  `note` captures, `remember` keeps a constraint, `forget` retracts a memory that turned
  out wrong, and `path` / `explain` / `affected` / `map` answer questions about structure.
  A guard hook refuses `grep`, `glob` and directory listings inside the vault, and says
  which call to make instead — searching by filename skips the embeddings and the graph,
  leaves no record of what was retrieved, and reads far more than the answer. Writing to
  the vault stays open; so does everything outside it. The CLI does the same things from
  a terminal.
- **Hybrid recall** — BM25 full-text (SQLite FTS5) + local semantic embeddings
  (all-MiniLM-L6-v2 via ONNX, 384-dim, sqlite-vec) fused with reciprocal-rank fusion,
  graph ranking boosts, best-section-per-note pooling. ~15 ms queries, finds notes by
  meaning ("laptop battery drains fast" → your power-tuning note). Results are trimmed
  to the lines that answer the question, not the whole section. A misspelt cue is
  corrected against the vault's own vocabulary, copies of the same note collapse into
  one hit, and a result that matches nothing well says so instead of bluffing — including
  the case that looks most convincing, where a question about something the vault has
  never heard of scores well because its other words are the vault's own jargon. Recall
  names the words no note contains, and the always-on prompt hook stays quiet when they
  are the words that carried the question.
- **Episodic memory** — the brain also remembers *what happened*, not just what you
  wrote down. Past sessions are mined from Claude Code's own transcripts, so recall
  answers "have we hit this before" alongside "what do we know". Nothing episodic is
  written to your vault; it lives in the local index only.
- **Standing instructions** — the rules you state in passing ("always run tsc before
  committing", "never publish that repo") are caught from the prompt, held apart from
  notes and episodes, and put in front of later sessions unasked. Saying one again
  strengthens it; saying the opposite replaces it, and the old one stops being offered
  rather than lingering to intrude. Only a handful compete for the space at the top of a
  session, so the strongest win and a rule about what you are doing right now comes
  forward. A rule you have repeated across sessions graduates into your `CLAUDE.md`,
  where it holds whether or not the daemon is running. `claude-brain rules` shows what is
  held and `--retract` drops one.
- **Memory that behaves like memory** — retrieving a note strengthens it, unused
  traces decay on a power-law curve, and recall spreads one hop along every kind of
  association — wikilinks, similarity, tags, notes that keep being recalled together —
  to surface the neighbouring note you didn't ask for. A note remembers when another
  session last used it, ranks a little higher in the directory it helped in before, and
  a session's working memory follows the thread of its questions until the topic
  changes. A failure that a later run survived is stored as an outcome, with the files
  edited in between. Recurring themes across separate sessions get flagged as
  candidates worth writing down.
- **Note graph you can traverse** — `path` between two notes, `explain` a note's
  neighbourhood, `affected` for everything pointing at it, `map` for the whole vault
  as named clusters. Links are typed from context (`caused_by`, `fixed_by`,
  `supersedes`, …) and supplemented by similarity, tag and timeline edges. No LLM
  anywhere: it rebuilds in ~100 ms on every change, so it is never stale.
- **Design memory** — drop screenshots of designs you like into the dashboard. Because
  recall is text, the brain converts each one into a written description of its design
  language (palette hex, spacing scale, typography, radii, shadows, motion, mood) and
  files it as a real note in your vault. Later, "build me a landing page like that
  dashboard I saved" actually resolves: `claude-brain design show "<vibe>"` prints the
  description and the image path.
- **`claude-brain reorganize`** — proposes a topical folder structure for a vault that
  grew organically, and files notes into it. It plans by default and moves nothing; only
  `--apply` touches the vault and `--undo` reverses it. It never renames, merges or
  deletes, and it refuses outright on a vault whose Obsidian link format would break
  links on a move.
- **A brain that looks and behaves like one** — every note sits on the cortex of a
  procedural brain: two folded hemispheres, the fissure between them, the cerebellum, a
  brainstem. Folders are lobes and take anatomical regions, the biggest first. Every kind
  of edge is a synapse (wikilinks, similarity, shared tags, notes recalled together, the
  journal timeline).
- **It is quiet until it is used.** At rest the brain is translucent tissue: cells are
  rim-lit membrane you can see through, synapses are faint threads, nothing glows and
  nothing moves. Then Claude Code calls a tool, and the daemon streams what it did: the
  notes the recall returned fire, signals set off down their synapses, arrive at the
  neighbours a beat later and fire those, and the volley dies out a few hops from where
  it started. `path` runs one signal along the route it actually walked. The status line
  says which tool, from where. A note you recall often fires harder than a cold one.
- **Fast with it** — the layout is computed once by the daemon and kept, so the brain
  looks the same each time and a new note lands in its lobe; the page draws cells, flares
  and signals as GPU-billboarded sprites with multisampled edges, one draw call per
  layer, and a whole volley is one buffer write, not a frame loop. The display's frame
  rate on an integrated GPU with well over a thousand notes.
- **A dashboard with a Home** — the brain in numbers, activity over the last two weeks
  (memories recorded, notes recalled), the notes you recall most, the themes that keep
  recurring across separate sessions, recent sessions and the largest clusters, all
  read live from the index. Controls are built from Uiverse components (MIT, credited in
  the stylesheet); no fonts or assets are fetched from anywhere.
- **Always fresh** — a file watcher reindexes seconds after you edit a note.
  Content-hash incremental: only changed notes are re-chunked and re-embedded.
- **You choose where the brain lives** — point it at an existing Obsidian vault or
  any folder of markdown. Switch anytime in Settings.
- **Cloud sync** — one-way mirror to your own **Dropbox**, **Google Drive**, or
  **MEGA** (via rclone; credentials stay in rclone on your machine). Dated remote
  trash folder protects against accidental deletions.
- **Claude Code integration, automatic** — the daemon wires itself in when it starts:
  the MCP server, recall-first instructions, hooks that orient at session start,
  quietly cue relevant memory as you work, and consolidate at session end, plus a
  recording skill so sessions save what they learned as new notes. Upgrading the
  package restarts the daemon, which brings all of that up to date; nothing to click.
  `claude-brain integrate --remove` unwires it and stays unwired.

## Install

```bash
yay -S claude-brain
```

## Use

```bash
claude-brain                 # opens the brain UI in your browser
```

First run: pick your vault location in **Settings** (detected Obsidian vaults are
suggested). The Claude Code side is already done — the daemon registered the MCP
server in `~/.claude.json` at user scope, installed the session hooks and added the
recall-first instructions the moment it started; restart Claude Code once to load the
tools. (`claude-brain integrate` does the same by hand.) Optional cloud sync:

```bash
claude-brain sync setup dropbox   # or: gdrive, mega
```

CLI reference:

```
claude-brain recall "<query>" [k] [-p <folder>] [-e <n>] [--full]
                                   search notes and past sessions
claude-brain note "<text>" [-f <subfolder>]      quick-capture (default Inbox/)
claude-brain remember "<text>" [-k decision|preference|outcome|rule]
                                   store a durable fact; rule-shaped text becomes a
                                   standing instruction
claude-brain rules [--retract <id>]
                                   the standing instructions, strongest first

claude-brain path "<from>" "<to>"  how two notes connect, hop by hop
claude-brain explain "<note>"      a note and everything around it
claude-brain affected "<note>"     what points at it, transitively
claude-brain map                   the vault as named clusters

claude-brain design list                         what designs are stored
claude-brain design add <path…> [--caption "…"]  save a design image
claude-brain design show "<id or vibe>"          its description, then the image path

claude-brain reorganize [--scope <folder>] [--dry-prompt] [--yes]
                                   plan a folder structure; moves nothing
claude-brain reorganize --apply [--plan <run-id>] [--yes]
claude-brain reorganize --undo [<run-id>]

claude-brain vault <path>          choose where your brain lives
claude-brain sync setup <provider> connect dropbox | gdrive | mega
claude-brain sync now              sync to the cloud now
claude-brain integrate [--remove]  wire into / out of Claude Code (MCP, hooks, instructions)
claude-brain mcp                   the MCP server over stdio — Claude Code runs this itself
claude-brain consolidate [days]    mine session logs, abstract, forget
claude-brain status                index + sync + integration state
claude-brain serve                 run the server in the foreground
```

The graph verbs resolve their arguments through recall, so you can describe a note
instead of naming it exactly: `claude-brain path "the audio crash" "deploy notes"`.

To keep the brain always on (recommended — recall stays warm for Claude Code):

```bash
systemctl --user enable --now claude-brain
```

## How it stores things

| What | Where |
|---|---|
| Config (vault path, sync, port) | `~/.config/claude-brain/config.json` |
| Search index | `~/.local/share/claude-brain/index.sqlite` |
| Embedding model (~90 MB, downloaded once) | `~/.cache/claude-brain/models/` |
| Sync log | `~/.local/state/claude-brain/sync.log` |

Your notes stay wherever you put your vault. Uninstalling the package touches none
of the above.

## Using your own Claude

Two features need judgement rather than search — describing a design, and deciding which
folder a note belongs in. Both call **your own already-authenticated `claude` CLI**; there
is no API key to configure and nothing is sent anywhere else.

Both are **off by default**. Nothing spends your Claude quota until you turn them on in
Settings, and there is a daily budget you can set. With them off, uploads are still stored
and listed (marked "disabled"), and everything else in the brain — recall, the graph,
episodic memory — is unaffected, because none of it uses an LLM at all.

## Privacy

- No telemetry. Embeddings, search, clustering and graph building are fully local and
  involve no model at all.
- The only thing that ever leaves your machine is what you explicitly enable above, and
  it goes through your own `claude` CLI to Anthropic — the same place your Claude Code
  sessions already go. Off by default. `claude-brain reorganize --dry-prompt` prints the
  exact text that would be sent, without sending it.
- Episodic memory is read from Claude Code's session logs already on your disk and
  stored only in the local index. It is never written into your vault and never synced.
- Cloud sync is off until you connect an account; it targets only your own storage and
  mirrors your vault, not the index.
- `claude-brain integrate --remove` cleanly removes everything it added to `~/.claude`.

## License

MIT
