export type PrReviewEvalScenarioId =
  | 'trivial-single-file'
  | 'small-coupled-change'
  | 'independent-domains'
  | 'named-path-or-symbol'
  | 'explorer-finds-issue'
  | 'explorer-no-issue'
  | 'insufficient-evidence'
  | 'second-wave-threshold'
  | 'clean-multi-domain'
  | 'inline-anchor-discipline'
  | 'security-conclusion'
  | 'follow-up-reviewer';

export type PrReviewEvalScenario = Readonly<{
  id: PrReviewEvalScenarioId;
  title: string;
  requiredFixtureFacts: readonly string[];
  delegation: 'none' | 'zero-or-one' | 'parallel' | 'targeted-follow-up';
  assertions: readonly string[];
}>;

/**
 * This is intentionally metadata, not pretend fixture coverage. Every entry
 * requires an externally supplied immutable repository revision before it can
 * become a live case.
 */
export const prReviewEvalScenarios: readonly PrReviewEvalScenario[] =
  Object.freeze([
    {
      id: 'trivial-single-file',
      title: 'Trivial single-file review',
      requiredFixtureFacts: ['one changed file', 'directly inspectable change'],
      delegation: 'none',
      assertions: ['valid final review', 'no Explore task'],
    },
    {
      id: 'small-coupled-change',
      title: 'Small coupled change',
      requiredFixtureFacts: ['tightly coupled changed files'],
      delegation: 'zero-or-one',
      assertions: ['valid final review', 'no artificial task lanes'],
    },
    {
      id: 'independent-domains',
      title: 'Independent domains',
      requiredFixtureFacts: ['two or three independent review domains'],
      delegation: 'parallel',
      assertions: ['parallel task batch', 'distinct scopes and exclusions'],
    },
    {
      id: 'named-path-or-symbol',
      title: 'Named path or symbol',
      requiredFixtureFacts: ['named changed path or symbol'],
      delegation: 'zero-or-one',
      assertions: ['direct target inspection before broad traversal'],
    },
    {
      id: 'explorer-finds-issue',
      title: 'Explorer finds a real issue',
      requiredFixtureFacts: ['seeded defect', 'exact changed-line evidence'],
      delegation: 'zero-or-one',
      assertions: ['seeded finding recall', 'minimal anchor verification'],
    },
    {
      id: 'explorer-no-issue',
      title: 'Explorer returns no issue',
      requiredFixtureFacts: ['delegated domain with supported clean result'],
      delegation: 'zero-or-one',
      assertions: ['no parent replay of delegated investigation'],
    },
    {
      id: 'insufficient-evidence',
      title: 'Insufficient evidence',
      requiredFixtureFacts: ['intentionally unavailable material fact'],
      delegation: 'targeted-follow-up',
      assertions: ['unresolved fact', 'bounded follow-up or supported result'],
    },
    {
      id: 'second-wave-threshold',
      title: 'Second-wave threshold',
      requiredFixtureFacts: ['named claim first wave cannot resolve'],
      delegation: 'targeted-follow-up',
      assertions: ['second wave only for the named unresolved claim'],
    },
    {
      id: 'clean-multi-domain',
      title: 'Clean multi-domain PR',
      requiredFixtureFacts: ['multiple independent clean domains'],
      delegation: 'parallel',
      assertions: ['empty findings', 'no unnecessary extra exploration'],
    },
    {
      id: 'inline-anchor-discipline',
      title: 'Inline anchor discipline',
      requiredFixtureFacts: ['one anchorable and one non-anchorable issue'],
      delegation: 'zero-or-one',
      assertions: ['RIGHT changed-line inline finding', 'report-only fallback'],
    },
    {
      id: 'security-conclusion',
      title: 'Security conclusion',
      requiredFixtureFacts: ['security-sensitive seeded issue'],
      delegation: 'zero-or-one',
      assertions: ['smallest security verification', 'no full replay'],
    },
    {
      id: 'follow-up-reviewer',
      title: 'Follow-up reviewer',
      requiredFixtureFacts: [
        'completed immutable review context',
        'follow-up question',
      ],
      delegation: 'targeted-follow-up',
      assertions: [
        'reuse review context',
        'delegate only new repository question',
      ],
    },
  ]);

export function prReviewEvalScenario(id: string): PrReviewEvalScenario | null {
  return prReviewEvalScenarios.find((scenario) => scenario.id === id) ?? null;
}
