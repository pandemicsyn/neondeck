import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardLayoutMode } from '../types';

/**
 * Named layout arrangements the deck flows between. Selection is driven by the
 * measured size of the deck shell, not by device width or a fixed resolution,
 * so the same engine works full-screen on the Xeneon Edge, in a window, or on a
 * portrait companion panel.
 *
 * Paired styling contract: web/src/styles.css consumes these names via
 * `[data-deck-profile]`, `[data-deck-arrangement]`, and `[data-region-role]`
 * attributes emitted from App.tsx. The vh-based column caps and the agent
 * floor live there; the thresholds below live here. Keep them coherent.
 */
export type DeckProfile = 'ultrawide' | 'wide' | 'portrait' | 'compact';

/**
 * The two structural arrangements. `grid` keeps the authored side-by-side
 * region map; `column` is a height-contained vertical stack where the agent
 * surface dominates.
 */
export type DeckArrangement = 'grid' | 'column';

export type DeckSize = { width: number; height: number };

// Below this width there isn't room for a side-by-side rail + main surface, so
// we go vertical regardless of aspect (narrow windows, phone-sized glances).
const COMPACT_MAX_WIDTH = 640;
// The Xeneon Edge is ~3.56:1; anything this wide is the hero ultrawide deck.
const ULTRAWIDE_MIN_ASPECT = 2.2;
// Down to roughly square we can still place a rail beside the main surface.
const WIDE_MIN_ASPECT = 1.1;

/**
 * Pure classifier: given a measured size and the configured mode, return the
 * profile. `mode` overrides measurement (`xeneon` pins the ultrawide deck,
 * `stacked` pins the vertical column); `auto` measures.
 */
export function classifyDeckProfile(input: {
  width: number;
  height: number;
  mode?: DashboardLayoutMode;
}): DeckProfile {
  const { width, height, mode } = input;

  if (mode === 'xeneon') return 'ultrawide';
  if (mode === 'stacked') return 'portrait';

  // Before the first measurement (or in non-DOM environments) assume the
  // authored side-by-side deck rather than flashing the column layout.
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return 'wide';
  }

  if (width < COMPACT_MAX_WIDTH) return 'compact';

  const aspect = width / height;
  if (aspect >= ULTRAWIDE_MIN_ASPECT) return 'ultrawide';
  if (aspect >= WIDE_MIN_ASPECT) return 'wide';
  return 'portrait';
}

export function deckArrangement(profile: DeckProfile): DeckArrangement {
  return profile === 'portrait' || profile === 'compact' ? 'column' : 'grid';
}

export type DeckProfileState = {
  ref: (node: HTMLElement | null) => void;
  profile: DeckProfile;
  arrangement: DeckArrangement;
};

/**
 * Observe the deck shell and derive the active profile from its real box size.
 * Uses ResizeObserver so it reacts to window resizes, density changes, and the
 * element being mounted in any container, not just full-screen.
 *
 * Only the discrete `profile` lives in state: the measured size is kept in a
 * ref and the resolved profile is committed only when it actually changes, so a
 * drag-resize produces one render per threshold crossing instead of one per
 * pixel. Raw width/height are intentionally not exposed; if a future consumer
 * needs a live pixel value, expose it as a `RefObject<DeckSize>` so the
 * non-reactive contract is part of the type.
 */
export function useDeckProfile(mode?: DashboardLayoutMode): DeckProfileState {
  const sizeRef = useRef<DeckSize>({
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
  });
  // modeRef lets the ResizeObserver callback see the latest mode without
  // re-creating the observer; it is updated inside the mode effect below so the
  // assignment never happens during render (React 18 concurrent rule).
  const modeRef = useRef(mode);
  const observerRef = useRef<ResizeObserver | null>(null);

  const [profile, setProfile] = useState<DeckProfile>(() =>
    classifyDeckProfile({ ...sizeRef.current, mode }),
  );

  // Re-classify from the latest measured size + mode, committing only on change.
  const apply = useCallback(() => {
    const next = classifyDeckProfile({
      ...sizeRef.current,
      mode: modeRef.current,
    });
    setProfile((prev) => (prev === next ? prev : next));
  }, []);

  const ref = useCallback(
    (node: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!node) return;

      const rect = node.getBoundingClientRect();
      sizeRef.current = { width: rect.width, height: rect.height };
      apply();

      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        sizeRef.current = {
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        };
        apply();
      });
      observer.observe(node);
      observerRef.current = observer;
    },
    [apply],
  );

  // Re-evaluate when the configured mode changes (e.g. live config reload).
  useEffect(() => {
    modeRef.current = mode;
    apply();
  }, [mode, apply]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return {
    ref,
    profile,
    arrangement: deckArrangement(profile),
  };
}
