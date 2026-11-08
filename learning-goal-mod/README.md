# Learning Goal Mod plugin guide

Learning Goal offers optional lessons connected to your coding work and a goal you set. See the [repository README](../README.md) for installation and a quick start.

## Controls

| Command or control | Behavior |
| --- | --- |
| `/learning-goal` | Open the goal and lesson pane |
| `/learning-goal demo` | Show a fictional invitation without a model request |
| `/learning-goal set <goal>` | Save and activate a goal; without text, use the default |
| `/learning-goal explain` | Request a lesson about the most recent substantive turn |
| `/learning-goal auto off` or `on` | Disable or enable automatic checks |
| `/learning-goal pause` or `resume` | Pause or restore coaching |
| `/learning-goal history` | View recent learning records and feedback |
| `/learning-goal export` | Export retained history and learning records to JSON |
| `/learning-goal status` | Show settings, check counts, and reported token usage |
| Mark as done | Finish a lesson without claiming mastery |
| Already know | Suppress introductory explanations matching that concept's name |
| Save for later | Save a lesson for reopening from History |
| Ask main agent | Append an editable question to the draft; never send it automatically |
| Dismiss | Close a lesson without marking it done |

The command is `/learning-goal` and the plugin identifier is `learning-goal-mod`.

## When it checks

Automatic mode is enabled by default after a goal is activated, unless you switch it off. Settings allow 0–20 automatic cards per rolling hour and a cooldown of 0–1,440 minutes between automatic cards. The defaults are two cards per hour and a five-minute cooldown. Settings are shared; limits are counted per chat. Manual explanations bypass these card limits.

Automatic model checks are also limited to six per session and at least five minutes apart. Checks happen after substantive completed main turns, while the session is idle. A check can consume account usage without producing a card. Manual requests cannot overlap another coaching request.

The mod ignores subagent turn completions, but an independent background chat can still be a main session. It does not currently detect whether a chat is visible. It isn't designed for simultaneous sessions writing the same files.

## State and data

The mod stores its goal and preferences in `~/.config/learning-goal-mod/goals.json`. The optional rationale explains why the goal matters. The file is created when you save a goal or preference. Invalid configuration is preserved and coaching stays inactive until it is repaired and the plugin is reloaded.

Opening, completing, saving, or marking a real lesson known writes a compact record to `~/.config/learning-goal-mod/learning-records.json`. It includes the goal text, concept, example quote, explanation, next question, and actions. A demo creates no record, and a dismissal alone does not create one. Invalid records are preserved and prevent coaching until repaired. There is a 1,000-record limit; reaching it prevents adding a record rather than silently deleting older ones.

Up to five records associated with the same exact goal text are selected by shared words with the latest answer and included in the next fork. This lexical matching can miss related concepts or select weak matches. Opening or completing a lesson is engagement, and “Already know” is self-reported; none proves mastery. A known concept may return when the coach identifies a new application, which is not independently verified.

Recent feedback and usage counters also use Claude Code's plugin store, which may be cleaned up after inactivity. Retention is bounded to 100 feedback actions and 20 session usage records. Export writes `~/.config/learning-goal-mod/history-export.json`.

Learning records may contain project details. A fork sends the session context and selected records through the session's existing model connection. The mod adds no analytics service, separate provider, or API key.

## Development and verification

From the repository root:

```sh
cd learning-goal-mod
./dev test
claude plugin validate .
claude plugin test .
```

The independent suite uses Node.js 20 or later. Claude Code loads the plugin directly and does not require a separate Node installation. The native test kit uses stubs; it does not establish live model quality, cost, or latency. The demo card and pane have also been exercised in Claude Desktop, along with a live automatic lesson.

For a local one-session terminal test, use `claude --plugin-dir /absolute/path/to/learning-goal-mod`. To measure the desktop invitation's accessibility rectangles on macOS, show the demo card and run `swift scripts/measure-card.swift` from this directory. This requires accessibility permission and measures accessibility boxes, not CSS padding.

## Limitations

- A single local session at a time is supported. Concurrent sessions can overwrite the shared goal and learning-record files; settings changes in one running session don't automatically refresh another.
- Checks occur at completed-turn boundaries, not during a long task. Evidence is the main agent's final answer, so an exact quote establishes what was said, not whether it is true.
- Known-concept matching is based on normalized names and exact goal text, not a semantic model of knowledge.
- The fork API does not provide cancellation. After 20 seconds, a late response is discarded and the request slot is held until it finishes. A request that never settles requires a reload; provider usage may still continue.
- Local installs do not automatically apply in cloud sessions. Some organization-managed configurations restrict mod events or installations.

## References

- [Claude Code mod overview](https://code.claude.com/docs/en/plugins/mods/overview)
- [Mod authoring](https://code.claude.com/docs/en/plugins/mods/create)
- [Model forks and background work](https://code.claude.com/docs/en/plugins/mods/api)
- [Mod interface](https://code.claude.com/docs/en/plugins/mods/interface)
- [Native testing](https://code.claude.com/docs/en/plugins/mods/test)
