# Fork architecture and merge policy

Read this before resolving any merge in this repository.

## The base

`pi` (`upstream` = earendil-works/pi) is the **base layer**. prime-agent is a
**layer on top of it**, not a parallel product. Ratified by the repository
owner and not open for re-litigation.

Remotes:

| remote | repository | role |
|---|---|---|
| `upstream` | earendil-works/pi | the base; everything is built on it |
| `origin` | PrimeIntellect-ai/prime-agent | the fork's mainline |
| `transmute` | TransmuteLabs/prime-agent | where this working line is published |

## What follows from it

- A fork-side parallel implementation of something pi already owns is an
  architectural error. Build on pi's mechanism instead of re-implementing it.
- Never drop pi logic to make a merge easier. Whatever is removed here is an
  upstream feature lost in every future merge.
- A fork change that **subtracts a pi seam** — un-exporting a helper pi's own
  tests use, deleting pi's tests, replacing a pi mechanism with a local one —
  is resolved back to pi's shape, and whatever the fork added on top is kept.
  Both sides survive: pi's seam plus the fork's extra coverage.
- Files pi does not have (daemon mode, the REPL kernel, RLM, feature hints,
  private Prime Inference routes, model-catalog curation) are the fork's own
  ground; cleanups there are accepted as the fork's call.

## Merge procedure

1. Resolve per file, semantically. `.js` relative specifiers coming from the
   fork are normalized to `.ts` (pi's convention, enforced by
   `scripts/check-ts-relative-imports.mjs`).
2. After resolving, sweep for silently lost tests: collect `test(` / `it(`
   names from `HEAD` and from the merge result and diff them. Every name that
   disappears must be explained — either the side that owns that code deleted
   it deliberately, or the merge dropped it and it goes back in.
3. `npm run check` must be clean, and the package suites are run from each
   package root before the merge is committed.
4. Record the resolution rationale in the merge commit message: what was taken
   from the fork, what was reverted to pi, and why.

## Generated model data

`packages/ai/src/providers/data/` is gitignored and hydrated locally
(`npm run hydrate:model-data`). Stale data there silently changes test
outcomes in both directions, so re-hydrate before trusting a catalog test.
Private Prime Inference routes are deliberately absent from the generated
catalog and are declared in
`packages/coding-agent/src/core/prime-inference-models.ts`.
