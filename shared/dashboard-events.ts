/**
 * Flue beta.9 treats GET paths ending in `/agents/:name/:id` as observation
 * streams that do not block a development reload. Keep the dashboard's
 * app-owned SSE endpoint in that shape until Flue can classify custom SSE
 * responses directly; the server and browser must continue sharing this path.
 */
export const dashboardEventStreamPath = '/api/events/agents/neondeck/dashboard';
