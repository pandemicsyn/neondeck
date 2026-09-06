import { instrument } from '@flue/runtime';
import { AsyncLocalStorage } from 'node:async_hooks';
import { runtimePaths } from '../../runtime-home';
import { dbRun } from './service';
import { getPlanningIntent, hashPlanning } from './planning-store';
// Metering only: Flue remains the owner of turns, attempts, queue and recovery.
// Stop before the next model call once four calls or 12k observed tokens are
// consumed. A single provider response can cross the token threshold.
export function assertTriageBudget(intentId: string) {
  return dbRun(runtimePaths(), (db) => {
    const rows = db
      .prepare('SELECT record FROM factory_planning_effects WHERE intent_id=?')
      .all(intentId);
    const usage = rows
      .map((r) => JSON.parse(String(r.record)))
      .filter((r) => r.kind === 'triage-usage');
    if (
      usage.length >= 4 ||
      usage.reduce((sum, row) => sum + row.tokens, 0) >= 12000
    )
      throw new Error('Triage turn/token budget exhausted.');
  });
}
// Flue's submission interceptor has agent identity; nested model interceptors
// have session identity only. Carry the runtime-bound scope through that chain.
const triageScope = new AsyncLocalStorage<
  { intentId: string; permittedTurns: Set<string> } | undefined
>();
let uninstall: (() => Promise<void>) | undefined;
export function installFactoryTriageBudget() {
  if (uninstall) return uninstall;
  uninstall = instrument({
    key: Symbol.for('neondeck.factory.triage-budget'),
    async interceptor(operation, context, next) {
      if (operation.type === 'agent' && context.agentName !== undefined) {
        if (context.agentName !== 'factory-triage')
          return triageScope.run(undefined, next);
        if (!context.instanceId?.startsWith('factory-triage-'))
          throw new Error('Triage model call lacks a bound instance.');
        return triageScope.run(
          {
            intentId: context.instanceId.slice('factory-triage-'.length),
            permittedTurns: new Set(),
          },
          next,
        );
      }
      const scope = triageScope.getStore();
      if (
        operation.type === 'model' &&
        scope &&
        !scope.permittedTurns.has(operation.turnId)
      ) {
        const { intentId } = scope;
        // This seam runs only for a provider call, never a finalization render.
        // A mixed tool batch may not honor terminate:true from just one tool;
        // fail that continuation before spending any additional model call.
        if (getPlanningIntent(intentId).triage)
          throw new Error(
            'Triage is already recorded; further model calls are blocked.',
          );
        assertTriageBudget(intentId);
        // Flue also intercepts stream iteration/result for the SAME turn.
        // Once admitted, its stream must drain even after usage is observed.
        // This live set is only reentrancy bookkeeping; durable usage is above.
        scope.permittedTurns.add(operation.turnId);
      }
      return next();
    },
    dispose() {
      uninstall = undefined;
    },
    observe(event) {
      if (
        event.type !== 'turn' ||
        event.agentName !== 'factory-triage' ||
        !event.instanceId?.startsWith('factory-triage-')
      )
        return;
      const intentId = event.instanceId.slice('factory-triage-'.length);
      dbRun(runtimePaths(), (db) => {
        if (
          !db
            .prepare('SELECT id FROM factory_planning_intents WHERE id=?')
            .get(intentId)
        )
          return;
        db.prepare(
          'INSERT OR IGNORE INTO factory_planning_effects (id,intent_id,record) VALUES (?,?,?)',
        ).run(
          hashPlanning({ intentId, turnId: event.turnId }),
          intentId,
          JSON.stringify({
            kind: 'triage-usage',
            tokens: event.response.usage?.totalTokens ?? 0,
          }),
        );
      });
    },
  });
  return uninstall;
}
installFactoryTriageBudget();
