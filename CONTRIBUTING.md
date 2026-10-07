# Contributing

Pull requests are welcome. Before opening one:

1. Run `npm run typecheck`, `npm test` and `npm run build`; CI runs the same checks. Add tests under `test/` for changes to `shared/` or `mcp/`.
2. Open the web app (`npm run dev`) and try the change in a browser. If you couldn't, say so in the pull request, so the reviewer knows it still needs a visual check.
3. Describe what changed for users, and how to try it.

## Guidelines

**Keep the diff to the change.** Don't reformat code you didn't change: rewrapped lines hide the real change from reviewers. Match the style of the code around you.

**Data model**

- New fields in the graph file are optional, so existing files keep working. Document them in "File format" in the [README](README.md).
- Code in `shared/` is used by the web app, the dev file API and the MCP server. A new top-level field must also be added to the MCP output schema in `mcp/server.ts`, or the MCP server will drop it when it saves.
- Validate input from files and reject what doesn't make sense, reporting it in `issues`. When in doubt, fail closed: a broken filter should show fewer nodes, never quietly show more.
- Data that refers to nodes by id (like a view's positions) must follow them: update it when a node is renamed, and drop it when the node is removed or no longer applies. Don't let leftover entries pile up in the file, including entries for nodes that don't exist.

**User interface**

- Keep the toolbar to one row. Put secondary controls behind a button that opens a panel (like **Views**) instead of adding another bar.
- Give a dialog one primary action. If two buttons end up doing nearly the same thing (e.g. "Apply" and "Save", or "Save" and "Update"), keep one.
- Getting back to the default state should take one click (like **×** to leave a view), not a choice among other options.
- Buttons that destroy or reset something use `btn danger` and sit together, apart from the primary action.
- Give buttons an icon from `web/components/Icon.tsx` as well as a short label, and name actions plainly and in the singular ("Edit filter", "Reset filter").
- Leave space between neighbouring buttons; use the `gap` of a flex row instead of margins.

## Developer Certificate of Origin

MapNotes is released under the [MIT License](LICENSE). Every commit in a pull request must be signed off to certify that you have the right to submit it under that license, as described in the [Developer Certificate of Origin](DCO) (DCO). The sign-off is a line at the end of the commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

`git commit -s` adds it using the `user.name` and `user.email` from your Git config. The email must match the commit's author email.

If your pull request has commits without it, sign them off and force-push:

```bash
git rebase --signoff master
git push --force-with-lease
```

### Contributing on behalf of an employer

Many employment contracts give the employer the rights to code you write, especially on work time or work equipment. If that applies to you, make sure your employer allows you to contribute this code under the MIT License before signing off. Your sign-off certifies that you have that right.
