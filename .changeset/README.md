# Changesets

We use [Changesets](https://github.com/changesets/changesets) to version and publish packages.

When you make a change worth a release, run:

```bash
pnpm changeset
```

This creates a markdown file in this directory describing the change. Commit it
together with your code. Releases are then cut by the GitHub Actions workflow.
