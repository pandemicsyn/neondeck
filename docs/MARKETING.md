# Campaign pages and measurement

The first paid-campaign landing pages are:

- `/for/pr-review/`
- `/for/pr-autopilot/`

They share `CampaignPage.astro` and use `CampaignProductPreview.astro` for
promise-specific product previews. Keep the ad headline and its destination
page aligned; do not turn these into alternate general-purpose homepages.

## Current measurement boundary

The installed Neondeck app sends no marketing or product telemetry. The
campaign pages currently make no analytics network requests either.

`BaseLayout.astro` exposes a credential-free browser event bridge on campaign
pages. It dispatches `neondeck:marketing` events and exposes
`window.neondeckTrackMarketing` for a future consent-gated provider adapter.
The current event names are:

- `campaign_view`
- `install_command_copy`
- `github_click`
- `docs_click`

Each event includes the campaign page, path, placement when applicable, and
the `utm_source`, `utm_campaign`, and `utm_content` query values when present.
These values are neither persisted nor transmitted by the current site.

## Adding the Reddit Pixel later

Do not place provider code in the campaign page components. Add one small
adapter that:

1. loads only after the visitor's applicable consent choice;
2. initializes from a deployment-provided public pixel id;
3. reports the page view and maps the three action events to Reddit custom
   conversion events;
4. does not send email addresses, stable user ids, or Neondeck app data; and
5. can be disabled without changing campaign markup.

Add a plain-language privacy page before enabling the adapter. Verify the
integration with Reddit Events Manager and the Pixel Helper before buying
traffic.

GitHub stars and npm downloads remain aggregate supporting outcomes. They are
not attributed to an individual campaign visitor.
