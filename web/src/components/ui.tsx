import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from 'react';
import { cn } from '../lib/cn';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('border border-line bg-panel text-ink', className)}
      {...props}
    />
  );
}

export function Badge({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center border border-line bg-soft px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted',
        className,
      )}
      {...props}
    />
  );
}

export function Button({
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        'inline-flex min-h-[28px] items-center justify-center border border-line bg-soft px-3 py-1.5 font-medium text-ink transition-colors hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'min-h-0 resize-none border-0 bg-transparent text-ink outline-none placeholder:text-muted focus:outline-none',
        className,
      )}
      {...props}
    />
  );
}

export function ScrollArea({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('min-h-0 overflow-auto', className)} {...props} />;
}

export function Separator({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('h-px bg-line', className)} {...props} />;
}

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn('font-mono text-[10px] text-muted', className)}
      {...props}
    />
  );
}

export function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="border border-line bg-field px-2 py-1">
      <span className="text-primary">{value}</span>
      <span className="ml-1">{label}</span>
    </div>
  );
}

export function StatusPill({
  label,
  ok,
  value,
}: {
  label: string;
  ok: boolean;
  value: string;
}) {
  return (
    <div className="border border-line bg-field px-2 py-1">
      <span className={ok ? 'text-primary' : 'text-accent'}>{value}</span>
      <span className="ml-1">{label}</span>
    </div>
  );
}

export function MiniEmpty({ label }: { label: string }) {
  return (
    <div className="border border-line bg-soft px-2.5 py-2 font-mono text-[10px] text-muted">
      {label}
    </div>
  );
}

export function EmptyState({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 px-4 text-center">
      <div className="miami-accent h-1 w-12" />
      <p className="text-[13px] font-semibold text-ink">{title}</p>
      <p className="max-w-[34ch] text-xs leading-5 text-muted">{detail}</p>
    </div>
  );
}

export function BootState({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg text-ink">
      <section className="border border-line bg-panel px-5 py-4">
        <h1 className="text-base font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-muted">{detail}</p>
      </section>
    </main>
  );
}
