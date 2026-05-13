# Caching strategy for the recipe-search API

> Example file for the Track Changes plugin. Open the side panel to see
> each comment and suggestion as a card. Comments are attributed by their
> `<Name>:` prefix — `Claude:` and `GPT:` each appear in their own color.

Search hits the `recipes` table on every keypress. {>>Claude: How many queries per second at peak today? The right strategy is very different at 100 qps versus 10k qps — name a number.<<} We've been talking about adding a cache layer but kept deferring it; this doc settles on an approach.

## Where we are now

Each typeahead character triggers a query with `LIKE '%term%'` against `title` and a `tsvector` match against `description`. {~~Postgres handles this fine~>Postgres handles this fine under our current load~~}, but the p99 has crept from 80ms to 220ms over the last quarter as the recipe count tripled.

{++The trailing-anchor `%term%` is the part that doesn't scale: it can't use the trigram index and forces a sequential scan once the title set gets large.++} {>>GPT: This sentence belongs *above* the previous one — cause should come before symptom. Reads weirdly out of order.<<}

## Option A — Redis cache keyed by prefix

Cache the result set keyed by the first three characters of the query. Most searches hit a small set of common prefixes; cold tail still goes to Postgres, but warm hits are O(1). {>>Claude: What's the invalidation story when a new recipe is added? "It'll TTL out" isn't the same as "it'll appear in search within X seconds" — be specific about the SLO you're promising.<<} {>>good catch, I had "5 min TTL" in a draft and dropped it. Adding back.<<} {>>Claude: Also note: a stale cache on a *deletion* is worse than on an *addition*. Recipes can be unlisted for legal reasons and that path needs an explicit invalidate, not just a TTL.<<}

## Option B — Replace LIKE with a proper full-text index

Drop the {==trailing-wildcard LIKE pattern==} and use Postgres's GIN-backed `tsvector` for everything. {--Probably a week of work.--}{++Estimate: 3 days for the migration plus a week of monitoring at parity before tearing down the fallback path.++} No new infra. {>>GPT: Strong preference for this over A. Adding Redis means a new failure mode (cache outage becomes search outage if you're not careful) and an operational thing to own. Avoid it if a schema change gets you the same wins.<<}

## Decision

We're going with B. {>>Claude: Worth a one-line "if this doesn't get us under 100ms p99, fall back to A" so the doc doesn't read as if you're betting everything on one option.<<}
