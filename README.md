# Learning Goal Mod for Claude Code

Learning Goal Mod is an experimental Claude Code mod that connects the work you are doing to a learning goal. It can offer an optional card when a completed response contains a useful teaching moment. Open the card for a short explanation, tradeoff, and question grounded in the work.

The mod runs in local Claude Code sessions, including the Code tab in Claude Desktop. It makes separate model requests with your session's model and credentials; these requests use your account's allowance even when no card is shown. This is an early personal-use experiment, not a learning assessment.

## Install

Requires Claude Code 2.1.301 or later for the current interface. In Claude Code, add this repository as a marketplace:

```text
/plugin marketplace add ptmr-gnai/Learning-Goal-Mod
/plugin install learning-goal-mod@learning-goal-mod
```

Choose **Install for you** to enable it in local projects on this machine. The internal plugin name is `learning-goal-mod`; the command you use is `/learning-goal`. In Claude Desktop, use the Code tab with **This computer** selected. Local plugins do not automatically load in cloud sessions.

If you installed an earlier version under a different plugin name, disable or uninstall that version before installing this one so both do not run at once. The [upgrade notes](learning-goal-mod/README.md#upgrading-from-the-earlier-plugin) describe how local files are copied and what stays in the earlier plugin's store.

The current version supports **one active local session at a time**: simultaneous sessions may overwrite shared goal or learning-record updates. Use project/local scope or disable the plugin in other sessions until concurrent writes are supported.

## Try it

In a local Claude Code session:

```text
/learning-goal demo
```

The demo displays a fictional card without a model request. Choose **Explain** to open the lesson. To try real coaching, open `/learning-goal`, switch automatic checks off if you prefer manual use, and save a goal. After a substantive turn, choose **Explain recent work**. Automatic mode is on by default when a goal is activated unless you turn it off.

See the [plugin guide](learning-goal-mod/README.md) for controls, frequency limits, data storage, and testing.

## Privacy and limitations

Goals and learning records are stored locally under `~/.config/learning-goal-mod/`. Records can contain lesson text and excerpts from your projects. A coaching fork sends the current conversation and selected learning records through the session's existing model connection. The mod does not add an analytics service or separate provider.

The coach relies on Claude's final answer, not independent verification of files or tests. Its retrieval uses simple word matching; lessons may be wrong or irrelevant. Opening or completing a lesson is engagement, not proof of mastery. Changes to settings are loaded per session, and concurrent writes are not coordinated.

## Development

From a checkout, run:

```sh
cd learning-goal-mod
./dev test
claude plugin validate .
claude plugin test .
```

The independent tests use Node.js 20 or later. Claude Code's native test runner uses stubs; it does not test live model quality. See the [plugin guide](learning-goal-mod/README.md) for details.

## License

[MIT](LICENSE)
