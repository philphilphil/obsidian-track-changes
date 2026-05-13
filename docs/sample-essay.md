# Why we stopped doing async-only

> Example file for the Track Changes plugin. Open the side panel to see
> each comment as a card. Comments are attributed by their `<Name>:` prefix —
> `Claude:` and `GPT:` each appear in their own color.

Two years ago we threw out our standup calendar. No meetings before 11am. Slack threads for everything. We even wrote a manifesto.

We've gone back. {>>Claude: Strong opening, but the manifesto bit needs a citation if it was public. Was it just internal?<<} This isn't a confession of failure — it's a note about which parts of "async-first" actually carry their weight, and which ones we were paying for in invisible currency.

The biggest hidden tax was decision latency. A thread that would have been resolved in a fifteen-minute call dragged across three timezones and four days. {~~Each round-trip~>Every reply~~} added a context-switch for whoever picked it up next, and by the time we had alignment the original question had drifted{++ or stopped mattering++}. {>>Claude: "Decision latency" is doing real work here — define it explicitly the first time, then use the shorthand. You're a sentence ahead of the reader.<<} {>>fair, will add a defining clause<<} {>>Claude: Good. Keep it short — something like "the time between asking a question and acting on the answer".<<}

The {==second tax was invisible escalation==}: small disagreements that would have been resolved by a glance across a table turned into multi-paragraph rebuttals. {--We learned that text amplifies tone--}{++Text amplifies tone++}, and you can't take back a Slack message the way you can soften a sentence mid-air. {>>GPT: This is the strongest paragraph in the piece. Consider leading with it.<<}

We still default to async for anything that doesn't need a decision. Status, plans, postmortems — those don't need a meeting. But "should we ship this" is a meeting now, and "is this person doing okay" is *definitely* a meeting now. {>>Claude: Worth a sentence on how you tell the two apart in practice — readers will ask.<<}

The lesson wasn't that async is bad. It's that async is a tool with a cost, and we'd been pretending it was free.
