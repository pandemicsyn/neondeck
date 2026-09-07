import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type UIEventHandler,
} from 'react';

const BOTTOM_THRESHOLD_PX = 48;

export function useChatAutoScroll(sessionId: string | undefined) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followsLatestRef = useRef(true);
  const [followsLatest, setFollowsLatest] = useState(true);
  const [hasNewActivity, setHasNewActivity] = useState(false);

  const jumpToLatest = useCallback(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;

    followsLatestRef.current = true;
    setFollowsLatest(true);
    setHasNewActivity(false);
    transcript.scrollTop = transcript.scrollHeight;
  }, []);

  const handleScroll = useCallback<UIEventHandler<HTMLDivElement>>((event) => {
    const transcript = event.currentTarget;
    const distanceFromBottom =
      transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop;
    const isAtBottom = distanceFromBottom <= BOTTOM_THRESHOLD_PX;

    followsLatestRef.current = isAtBottom;
    setFollowsLatest(isAtBottom);
    if (isAtBottom) setHasNewActivity(false);
  }, []);

  useLayoutEffect(() => {
    jumpToLatest();
  }, [jumpToLatest, sessionId]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;

    const followLayout = () => {
      if (followsLatestRef.current && transcript.clientHeight > 0)
        transcript.scrollTop = transcript.scrollHeight;
    };
    // Images, expanded details, fonts and hidden panels can resize without text
    // mutations. Observe both the viewport and its content, preserving scrollback.
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(followLayout);
    resizeObserver?.observe(transcript);
    const observeContent = () => {
      for (const child of transcript.children) resizeObserver?.observe(child);
    };
    observeContent();
    const observer = new MutationObserver(() => {
      observeContent();
      if (followsLatestRef.current) {
        transcript.scrollTop = transcript.scrollHeight;
        return;
      }

      setHasNewActivity(true);
    });
    observer.observe(transcript, {
      characterData: true,
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
      resizeObserver?.disconnect();
    };
  }, []);

  return {
    followsLatest,
    handleScroll,
    hasNewActivity,
    jumpToLatest,
    transcriptRef,
  };
}
