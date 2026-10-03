# Contributing

Pull requests are welcome. Before opening one, run `npm run typecheck`, `npm test` and `npm run build`; CI runs the same checks.

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
