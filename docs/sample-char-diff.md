# Per-character diff highlighting (issue #21)

> Example file for the Track Changes plugin. Every block below is a
> `{~~old~>new~~}` substitution. Open the side panel to see each as a "Replace"
> card — only the characters that actually changed should be highlighted on the
> red (old) and green (new) sides. The same emphasis appears inline in Live
> Preview. Each heading says what you should see lit.

## Single punctuation swap — only `&` → `and` lit

The original issue: when one token changes, the surrounding words and spaces stay calm and the edit pops. Tom {~~cats & dogs~>cats and dogs~~} Jerry — the shared `cats ` and ` dogs` (spaces included) stay muted; only the middle lights.

## Within-word typo — only the swapped letters lit

I want to {~~recieve~>receive~~} the file. The shared `rec` / `eve` stays muted; only the transposed `i`/`e` is highlighted.

## Insertion only — nothing lit on the old side

The British spelling of {~~color~>colour~~} adds a single letter. The old side shows no highlight at all; the new side lights just the inserted `u`.

## Deletion only — nothing lit on the new side

The American spelling of {~~colour~>color~~} drops a letter. The new side shows no highlight; the old side lights just the removed `u`.

## Prefix-only change — only the leading chars lit

A {~~mega-watt~>kilo-watt~~} reactor. Only the differing prefix changes; the shared `-watt` tail stays muted.

## Suffix-only change — only the trailing chars lit

Render it as {~~markdown~>markup~~} instead. The shared `mark` prefix stays muted; only the differing tail lights.

## Multiple separate changes in one block — each run lit independently

The fox: {~~the cat sat on the mat~>the dog sat on the rug~~}. The shared ` sat on the ` (and `the ` at the start) stays muted; `cat`→`dog` and `mat`→`rug` each light as their own run.

## Realistic sentence rewrite — several scattered runs

Performance note: {~~Postgres handles this fine~>Postgres handles this fine under our current load~~} for now. The shared leading text stays muted; the appended clause lights.

## Whitespace-significant change — the spaces around the symbol matter

Spacing fix: {~~a+b~>a + b~~} in the formula. The inserted spaces around `+` are real characters and are highlighted on the new side.

## Multi-line substitution — diff spans the newline

Reformat the list:

{~~one, two, three~>one
two
three~~}

The shared words stay muted; the inserted newlines/commas are what changed.
