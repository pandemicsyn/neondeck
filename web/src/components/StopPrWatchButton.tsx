import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { controlPrAutopilot } from '../api';
import { queryErrorMessage, queryKeys } from '../lib/query';
import { Button } from './ui';

type StopPrWatchButtonProps = {
  watchId: string;
  label?: string;
};

export function StopPrWatchButton({
  watchId,
  label = 'stop',
}: StopPrWatchButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => controlPrAutopilot(watchId, 'stop'),
    onSuccess() {
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.prWatches });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.autopilotState,
      });
    },
  });
  const error = mutation.error ? queryErrorMessage(mutation.error) : undefined;
  const buttonClass =
    'min-h-[28px] shrink-0 border-line bg-transparent px-2 py-1 text-[10px] text-muted hover:border-accent hover:text-accent';

  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {confirming ? (
        <>
          <Button
            aria-label={`Confirm stop watching ${watchId}`}
            className={`${buttonClass} border-accent text-accent`}
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
            title={error}
            type="button"
          >
            {mutation.isPending ? 'stopping' : error ? 'retry' : 'confirm'}
          </Button>
          <Button
            aria-label={`Cancel stop watching ${watchId}`}
            className={buttonClass}
            disabled={mutation.isPending}
            onClick={() => setConfirming(false)}
            type="button"
          >
            cancel
          </Button>
        </>
      ) : (
        <Button
          aria-label={`Stop watching ${watchId}`}
          className={buttonClass}
          onClick={() => setConfirming(true)}
          title={`Stop watching ${watchId}`}
          type="button"
        >
          {label}
        </Button>
      )}
      <span aria-live="polite" className="sr-only">
        {error ? `Could not stop watching ${watchId}: ${error}` : ''}
      </span>
    </span>
  );
}
