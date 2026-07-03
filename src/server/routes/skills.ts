import { Hono } from 'hono';
import {
  listRuntimeSkills,
  loadRuntimeSkill,
  reloadRuntimeSkills,
} from '../../runtime-skills';
import type { RuntimePaths } from '../../runtime-home';
import {
  applySkillPatchCandidate,
  listSkillPatchCandidates,
  rejectSkillPatchCandidate,
  restoreSkillPatchCandidate,
} from '../../skill-patches';
import { boundedQueryLimit, safeJsonObject } from '../http';
import { learningCandidateStatus } from './learning';

export function createSkillRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/patches', async (c) => {
    const status = learningCandidateStatus(c.req.query('status'));
    if (c.req.query('status') && !status) {
      return c.json(
        {
          ok: false,
          action: 'skill_patch_list',
          changed: false,
          message: `Invalid candidate status "${c.req.query('status')}".`,
        },
        400,
      );
    }
    if (c.req.query('limit') && !boundedQueryLimit(c.req.query('limit'), 100)) {
      return c.json(
        {
          ok: false,
          action: 'skill_patch_list',
          changed: false,
          message: `Invalid patch limit "${c.req.query('limit')}".`,
        },
        400,
      );
    }
    return c.json(
      await listSkillPatchCandidates(
        {
          status,
          skillId: c.req.query('skillId') || undefined,
          limit: boundedQueryLimit(c.req.query('limit'), 100),
        },
        paths,
      ),
    );
  });

  routes.post('/patches/:id/apply', async (c) => {
    const result = await applySkillPatchCandidate(
      { ...(await safeJsonObject(c)), id: c.req.param('id') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/patches/:id/reject', async (c) => {
    const result = await rejectSkillPatchCandidate(
      { ...(await safeJsonObject(c)), id: c.req.param('id') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/patches/:id/restore', async (c) => {
    const body = await safeJsonObject(c);
    const result = await restoreSkillPatchCandidate(
      { ...body, id: c.req.param('id') } as {
        id: string;
        confirm: true;
        reason?: string;
      },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.get('/', async (c) => {
    return c.json(await listRuntimeSkills(paths));
  });

  routes.get('/:id', async (c) => {
    const result = await loadRuntimeSkill({ id: c.req.param('id') }, paths);
    if (!result.ok) {
      return c.json(result, 404);
    }

    return c.json(result);
  });

  routes.post('/reload', async (c) => {
    return c.json(await reloadRuntimeSkills(paths));
  });

  return routes;
}
