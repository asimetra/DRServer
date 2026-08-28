# Redistribution and the release boundary

This page is for somebody who already has this repository in front of them: a
contributor deciding whether a change is safe to commit, somebody forking the
project and wanting to publish their own version, or somebody checking whether
this project is above board before trusting it.

What may and may not be redistributed is in [../NOTICE.md](../NOTICE.md). This
page is about how that boundary is enforced in practice, and why the repository
looks the way it does.

## Why the history starts where it does

This repository's history begins at a redistributable baseline rather than at
the beginning of the work. That is deliberate, and it is worth stating plainly
because a short history on an otherwise mature project usually means something
was hidden.

Development involved compatibility data, packet captures and notes derived from
reading a client. None of that is ours to publish. Deleting such files from the
latest commit does not remove them from earlier ones — Git preserves every blob
it has ever recorded — so a repository that had once committed them could not be
made publishable by deleting them.

A history rewrite was possible but rejected: it affects every branch, tag,
signature, fork and existing clone, and leaves nobody able to verify cheaply
that it worked. Starting from an allowlisted baseline is easier to check — the
whole history either contains a forbidden path or it does not — and much harder
to recontaminate by accident.

## What stops private material reaching the public tree

Three mechanisms, each covering a case the others miss.

**`.gitignore` denies by default where it matters.** `docs/` is the clearest
example: everything in it is ignored and the publishable files are named one by
one. Adding a private research note is therefore safe by default, and the cost —
a genuinely public document staying invisible until it is listed — is the right
way round. The same pattern covers captures, logs, runtime accounts, imported
compatibility data and client-derived patch material.

**`npm run check:public` inspects both the working tree and the history.**

```bash
npm run check:public
```

It walks the checkout for forbidden paths, binary and capture extensions,
oversized files and text that should never appear, then walks every path this
repository has ever recorded through `git rev-list --objects --all`. The second
half exists because the first half is not enough: a spotless checkout can sit on
top of a history that is not publishable, and the history is what gets pushed.

`--all` rather than `HEAD` is deliberate. It reaches every branch, tag and remote
ref, and also the detached HEAD of a stale worktree — which is not a theoretical
case. During this project's own release preparation, every visible ref was clean
while an abandoned worktree kept 238 commits of pre-sanitisation history
reachable in the object store. A check that only walked `HEAD` reported success.

**`game-data/manifest.json` describes required files without containing them.**
It is a list of names and SHA-256 checksums. A hash is not the work it
identifies, so publishing one distributes nothing, and it lets an operator verify
their own import (`npm run check:data`) while demonstrating that this repository
does not carry the files themselves.

## If you fork this and want to publish your own version

Run `npm run check:public` before the first push and after anything that touches
ignored directories. If it reports history findings, the working tree is not the
problem — prune stale worktrees, drop old refs, garbage-collect, and check again:

```bash
git worktree prune
git gc --prune=now
npm run check:public
```

If your fork ever committed material the boundary forbids, treat a rewrite as
insufficient on its own: assume old objects may already have been cloned or
cached, and get qualified advice before relying on it.

## Why filenames are not the main boundary

The U.S. Copyright Office explains that names, titles and short phrases are not
protected by copyright, although they may be protected as trademarks. It also
explains that copyright in computer programs covers copyrightable expression,
not functional aspects such as logic, algorithms or system design. That is why
this project removes copied data, code and assets while retaining the interface
identifiers the compatibility protocol technically requires — class names,
numeric field ids, opcodes and the filenames a client expects to find locally.

The same reasoning is why [client-setup.md](client-setup.md) can name a
configuration key. Describing which setting decides where a program connects is
a statement of fact about an interface, not a reproduction of expression.

Trademark and reverse-engineering rules vary by jurisdiction. The EU software
directive, for example, describes a conditional interoperability exception and
limits how information obtained under it may be used. Do not assume one
country's exception applies everywhere.

Authoritative starting points:

- [U.S. Copyright Office: what copyright protects](https://www.copyright.gov/help/faq/faq-protect.html)
- [U.S. Copyright Office Circular 61: computer programs](https://www.copyright.gov/circs/circ61.pdf)
- [WIPO trademark overview](https://www.wipo.int/en/web/trademarks/index)
- [EU Directive 2009/24/EC, Articles 5–6](https://eur-lex.europa.eu/legal-content/en/TXT/?uri=CELEX%3A32009L0024)
- [GitHub: removing data from repository history](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)

This page is operational guidance, not legal advice.
