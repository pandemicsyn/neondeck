import type { RepoDiffFile } from '../../api';

export type DiffFilePatch = Omit<RepoDiffFile, 'patch'> & {
  patch?: string | null;
  message?: string | null;
};

export type DiffViewTone = 'primary' | 'violet' | 'accent';
