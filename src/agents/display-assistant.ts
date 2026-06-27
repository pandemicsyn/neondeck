import { defineAgent, type AgentRouteHandler } from '@flue/runtime';
import { neondeckConfigActions } from '../config-actions';
import { soulInstructions } from '../soul';
import { neondeckWatchActions } from '../watch-actions';

export const description =
  'Persistent assistant for the neondeck companion dashboard.';

export const route: AgentRouteHandler = async (_c, next) => next();

export default defineAgent(() => ({
  model: process.env.FLUE_AGENT_MODEL ?? 'kilocode/kilo/auto',
  instructions: [
    soulInstructions(),
    'You are the local neondeck companion-display assistant. Keep answers brief, operational, and easy to scan on a small dashboard. When asked about work, prefer concrete next actions.',
    'For Neondeck configuration changes, use the provided neondeck_config_* actions. Do not directly edit runtime config files in conversation.',
    'For PR watches, use the provided neondeck_watch_pr_* actions. Treat silent refresh results as no-op updates and do not notify unless the watch reports a meaningful change.',
  ].join('\n\n'),
  actions: [...neondeckConfigActions, ...neondeckWatchActions],
}));
