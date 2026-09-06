import type { DeliveryDetail } from '../../api/factory-delivery';

export function FactoryDeliveryCommits({ detail }: { detail: DeliveryDetail }) {
  const { commits, effects } = detail.pipeline;
  if (commits.length === 0) return null;
  return (
    <details>
      <summary>Commit receipts</summary>
      {commits.map((commit) => {
        const pushed = effects.some(
          (effect) =>
            effect.kind === 'push' &&
            effect.state === 'delivered' &&
            JSON.stringify(effect.revision) === JSON.stringify(commit.revision),
        );
        return (
          <p key={commit.publishedHeadSha}>
            <strong>
              {pushed
                ? 'Confirmed pushed commit'
                : 'Local commit · push not confirmed'}
            </strong>
            : <code>{commit.publishedHeadSha}</code>
            <br />
            Tree: <code>{commit.treeSha}</code>
            <br />
            Evidence: <code>{commit.evidenceRef}</code>
          </p>
        );
      })}
    </details>
  );
}
