# New PR Review Briefing

Replacing the two-report PR review artifact surface with a single briefing, and
putting the agent's recommendation on the Reviews panel row.

- `PLAN.md` — the implementation plan. Status: proposed.
- `mockups/` — interactive Design Component mockups and the canvas manifest.

Supersedes `../archived/PR_REVIEW_REPORT_DECK_PLAN.md`, which proposed a slide
deck. That direction was explored and dropped; the plan here does not build on
it and does not treat it as a source.

## The short version

A review agent that recommends `approve` or `needs-human` changes what the
artifact surface is for. It stops being a report you read and becomes the place
a decision gets made — or, when the recommendation is trustworthy, a place you
never open, because the row in the Reviews panel already carried enough.

Three things the design settled on that are easy to get wrong:

- **Two recommendations, not three.** A tier whose available action is identical
  to another tier is content, not a tier.
- **The agent does not draft the approval note.** Asked whether anything is
  worth flagging, it will find something every time, and that noise would
  publish under the reviewer's name.
- **The recommendation is not `PrReviewRecord.verdict`.** That field already
  exists and holds the human's submitted GitHub verdict. Conflating them
  collapses the one distinction the UI has to preserve.
