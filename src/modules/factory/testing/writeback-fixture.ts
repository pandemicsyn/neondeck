/** Synthetic provider for the standalone UI evidence server. Never calls GitHub. */
import type {
  GitHubConnection,
  GitHubIssue,
  GitHubComment,
} from '../../../../shared/factory-github';
import type { RuntimePaths } from '../../../runtime-home';
import { GitHubApiError } from '../../github';
import { runFactoryWriteback, type WritebackIO } from '../writeback';
export function writebackFixture(
  connection: GitHubConnection,
  issue: GitHubIssue,
  paths: RuntimePaths,
) {
  const comments: GitHubComment[] = [];
  let mode = 'normal',
    nextId = 1001;
  const now = () => new Date().toISOString();
  const io: WritebackIO = {
    repository: async () => ({
      id: Number(connection.repositoryId),
      owner: { login: connection.owner },
      name: connection.name,
    }),
    issue: async () => issue,
    identity: async () => ({ login: 'fixture-neon', id: 77 }),
    comments: async (_c, _n, page) => ({
      items: comments.slice((page - 1) * 25, page * 25),
      hasNext: comments.length > page * 25,
    }),
    comment: async (_c, id) => {
      const c = comments.find((c) => String(c.id) === id);
      if (!c) throw new GitHubApiError(404, null, 'Synthetic missing comment');
      return { ...c };
    },
    create: async (_c, _n, body) => {
      if (mode === 'denied')
        throw new GitHubApiError(403, null, 'Synthetic denied write');
      const c = {
        id: nextId++,
        body,
        user: { login: 'fixture-neon', id: 77 },
        created_at: now(),
        updated_at: now(),
      };
      comments.push(c);
      if (mode === 'lost-receipt') throw new Error('Synthetic lost receipt');
      return { ...c };
    },
    update: async (_c, id, body) => {
      const c = comments.find((c) => String(c.id) === id)!;
      c.body = body;
      c.updated_at = now();
      return { ...c };
    },
  };
  return {
    io,
    run: () => runFactoryWriteback(paths, io),
    setMode(value: string) {
      mode = value;
      if (mode === 'edit' && comments[0]) {
        comments[0].body =
          'Synthetic remote human edit. Preserve this until an explicit repair.';
        comments[0].updated_at = now();
      }
      if (mode === 'delete') comments.splice(0, 1);
    },
  };
}
