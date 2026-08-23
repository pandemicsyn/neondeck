# Campaign pages and measurement

The paid-campaign landing pages with Reddit measurement are:

- `/for/pr-review/`
- `/for/pr-autopilot/`
- `/for/review-open-call/`

The two product campaigns share `CampaignPage.astro` and use
`CampaignProductPreview.astro` for promise-specific product previews. The
review open call has a dedicated layout but participates in the same
consent-gated measurement path. Keep the ad headline and its destination page
aligned; do not turn these into alternate general-purpose homepages.

## Current measurement boundary

The installed Neondeck app sends no marketing or product telemetry. The
campaign pages make no analytics network requests until a visitor opts in to
advertising measurement. The choice is stored locally in the visitor's browser
under `neondeck-marketing-consent`.

`BaseLayout.astro` exposes a credential-free browser event bridge on campaign
pages. It dispatches `neondeck:marketing` events and exposes
`window.neondeckTrackMarketing` for the consent-gated provider adapter.
The current event names are:

- `campaign_view`
- `install_command_copy`
- `github_click`
- `docs_click`

Each event includes the campaign page, path, placement when applicable, and
the `utm_source`, `utm_campaign`, and `utm_content` query values when present.
The Reddit adapter does not explicitly pass these contextual properties to the
provider. As part of an ordinary browser pixel request, Reddit can still receive
the current campaign URL, including its query string.

## Reddit Pixel

`MarketingConsent.astro` is the only provider adapter. It:

1. loads only after the visitor explicitly allows measurement;
2. initializes the public Reddit Pixel id `t2_4ljtr`;
3. reports `PageVisit` and maps `install_command_copy` and `github_click` to
   the custom conversions `InstallCommandCopy` and `GitHubClick`;
4. does not send email addresses, stable user ids, or Neondeck app data; and
5. ignores docs clicks and the event bridge's contextual properties.

The public Pixel id is intentionally committed because browser visitors can
always inspect it. A future Conversions API access token must be stored as a
Cloudflare Worker secret and must never enter this repository or browser code.
The disclosure and choice controls live at `/privacy/`.

Verify the integration with Reddit Events Manager and the Pixel Helper before
buying traffic.

GitHub stars and npm downloads remain aggregate supporting outcomes. They are
not attributed to an individual campaign visitor.
