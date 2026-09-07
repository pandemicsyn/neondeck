import * as v from 'valibot';
import {
  linearIssueSchema,
  type LinearConnection,
} from '../../../shared/factory-linear';
import { linearGraphql, LinearApiError } from './client';

// https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql
const fields = `id identifier url title description updatedAt archivedAt team { id } project { id } state { id type } labels(first: 100) { nodes { id } pageInfo { hasNextPage } }`;
const remoteIssue = v.object({
  ...linearIssueSchema.entries,
  labels: v.object({
    nodes: linearIssueSchema.entries.labels,
    pageInfo: v.object({ hasNextPage: v.boolean() }),
  }),
});
const organization = v.object({ id: v.string() });
function checkOrganization(
  actual: { id: string },
  connection: LinearConnection,
) {
  if (actual.id !== connection.organizationId)
    throw new LinearApiError('Linear organization binding mismatch.', 403);
}
function normalize(issue: v.InferOutput<typeof remoteIssue>) {
  if (issue.labels.pageInfo.hasNextPage)
    throw new LinearApiError('Linear issue labels exceed supported page size.');
  return { ...issue, labels: issue.labels.nodes };
}
function parse<T extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  schema: T,
  value: unknown,
): v.InferOutput<T> {
  const parsed = v.safeParse(schema, value);
  if (!parsed.success)
    throw new LinearApiError('Linear returned an invalid result.');
  return parsed.output;
}
export async function readLinearIssue(
  connection: LinearConnection,
  issueId: string,
  signal?: AbortSignal,
) {
  const data = parse(
    v.object({ organization, issue: remoteIssue }),
    await linearGraphql(
      process.env[connection.tokenEnv]!,
      `query FactoryIssue($id: String!) { organization { id } issue(id: $id) { ${fields} } }`,
      { id: issueId },
      signal,
    ),
  );
  checkOrganization(data.organization, connection);
  if (data.issue.id !== issueId)
    throw new LinearApiError('Linear issue identity mismatch.');
  return normalize(data.issue);
}
export async function readLinearIssuesPage(
  connection: LinearConnection,
  cursor: string | null,
  signal?: AbortSignal,
) {
  const data = parse(
    v.object({
      organization,
      issues: v.object({
        nodes: v.pipe(v.array(remoteIssue), v.maxLength(25)),
        pageInfo: v.object({
          hasNextPage: v.boolean(),
          endCursor: v.nullable(
            v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
          ),
        }),
      }),
    }),
    await linearGraphql(
      process.env[connection.tokenEnv]!,
      `query FactoryIssues($after: String, $filter: IssueFilter) { organization { id } issues(first: 25, after: $after, filter: $filter, includeArchived: true) { nodes { ${fields} } pageInfo { hasNextPage endCursor } } }`,
      {
        after: cursor,
        filter: {
          team: { id: { eq: connection.teamId } },
          ...(connection.projectId
            ? { project: { id: { eq: connection.projectId } } }
            : {}),
        },
      },
      signal,
    ),
  );
  checkOrganization(data.organization, connection);
  const page = data.issues.pageInfo;
  if (page.hasNextPage && (!page.endCursor || page.endCursor === cursor))
    throw new LinearApiError('Linear pagination did not advance.');
  return {
    items: data.issues.nodes.map(normalize),
    cursor: page.hasNextPage ? page.endCursor : null,
  };
}
export async function updateLinearIssueState(
  connection: LinearConnection,
  issueId: string,
  stateId: string,
  signal?: AbortSignal,
  beforeMutation?: () => void,
) {
  const token = process.env[connection.tokenEnv]!;
  // Validate credential binding before sending a mutation, not merely in its response.
  const identity = parse(
    v.object({ organization }),
    await linearGraphql(
      token,
      'query FactoryOrganization { organization { id } }',
      {},
      signal,
    ),
  );
  checkOrganization(identity.organization, connection);
  beforeMutation?.();
  const data = parse(
    v.object({
      issueUpdate: v.object({
        success: v.literal(true),
        issue: v.object({
          id: v.string(),
          updatedAt: linearIssueSchema.entries.updatedAt,
          state: v.object({ id: v.string() }),
        }),
      }),
    }),
    await linearGraphql(
      token,
      'mutation FactoryState($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id updatedAt state { id } } } }',
      { id: issueId, stateId },
      signal,
    ),
  );
  const issue = data.issueUpdate.issue;
  if (issue.id !== issueId || issue.state.id !== stateId)
    throw new LinearApiError('Linear state writeback receipt mismatch.');
  return issue;
}
