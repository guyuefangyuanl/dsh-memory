---
name: memory-maintenance
description: Use when the saved memory store needs a pass over it rather than a single read or write — the index has grown noisy, two notes seem to say the same thing, a note looks out of date, links point at notes that no longer exist, or the user asks to clean up, consolidate, prune, or audit what has been remembered.
---

# Memory maintenance

A memory store degrades in a specific way: nobody deletes anything. Notes accumulate, two of them
end up covering the same fact from different angles, and a fact recorded in March quietly stops being
true in June without anything marking it. The index still loads on every turn, so the cost is paid
every single request, and the value drops as the noise rises.

This is a pass over the whole store. Do it when asked, or when a memory you just read turns out to be
wrong — the second one is the important trigger, because that is proof the store has drifted.

## Work the pass in this order

**1. Take inventory.** `memory` with action `list`. Read the whole index at once. You are looking for
shape, not detail: how many notes, how they split across `user`/`feedback`/`project`/`reference`,
whether any description is too vague to decide from.

**2. Find the collisions.** Two notes collide when a future session would not know which one to open.
`search` for the load-bearing nouns in the store — the project names, the tool names, the recurring
decisions — and see which queries return more than one note. `write` warns about near-duplicates at
creation time, but only for the description, and only on first write; overlap that grew later shows
up here and nowhere else.

**3. Merge, do not stack.** When two notes cover one fact, write the merged note under the name that
better describes the fact, then `delete` the other. Keep every detail worth keeping — merging is not
summarizing. Two notes that genuinely disagree are the interesting case: that is a fact that changed,
so record the current state and say what it replaced, rather than keeping the contradiction on disk.

**4. Check the notes that make claims about code.** Any memory naming a file, function, flag, table,
or endpoint is a claim that can go stale silently. `read` those and verify the thing still exists.
If it moved, `edit` the note — quote the stale sentence as `old_string` and replace just that, rather
than resending the whole body through `write` and risking losing a detail you did not mean to touch.
If the whole premise is gone, delete it — an empty store beats a confidently wrong one.

**5. Work the unwritten-link backlog.** `list` returns `unwritten`: names that existing notes link to
but nobody has written, ordered by how many notes want them. These are not broken links. Each one is
a past session saying "this deserves its own note" — the most-referenced ones are the facts the store
is most obviously missing. Write the ones you can now write truthfully, and leave the rest; an
unwritten link costs nothing and keeps the intent visible.

The one case that does need repair is a name that used to exist. When you delete or rename a note,
`delete` tells you who still links to it. If the fact moved, repoint those links at where it went. If
the fact simply stopped being true, leaving the link is fine — it will just sit in the backlog.

**6. Re-read the descriptions.** The description is the only thing a future session sees before
deciding whether to open the note, and it is loaded on every request. It should say what the note
settles, not what it is about. "Deploy notes" is a topic; "deploys go to the staging bucket, prod is
manual and requires the release captain" is a fact. Rewrite the ones that are only topics — `edit`
with a new `description` changes just that line and leaves the body alone.

## What does not belong in memory

Delete on sight, whatever the type:

- Anything the repository already states — layout, APIs, dependency versions, commit history, the
  contents of the contributor guide. The repo is authoritative and the memory copy will drift from it.
- Task state from a finished task. "Currently debugging the retry loop" was true for an afternoon.
- Relative dates. A note saying "decided last week" is unreadable on replay. Rewrite with the
  absolute date if it is recoverable, delete it if not.
- Anything recorded because it was interesting rather than because a later session needs it.

## Scope

Notes live in two layers. `global` notes apply to every project — who the person is, how they want to
be worked with. `project` notes belong to one working directory. A note in the wrong layer is a real
defect: a project fact promoted to global will mislead every other repository. Moving one means
writing it to the correct scope and deleting the original.

## Finishing

Say what changed: how many notes were merged, deleted, rewritten, and what the store holds now. If
you deleted something the user might have wanted kept, name it explicitly rather than burying it in a
count — deletion is the one step here that cannot be undone from inside the tool.
