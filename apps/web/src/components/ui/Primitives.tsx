import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-white/10 bg-tint-card/70 ${className}`}>
      {children}
    </div>
  );
}

export function Field({
  label,
  helper,
  error,
  children,
  htmlFor,
}: {
  label: string;
  helper?: string;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-sm font-medium text-white">
        {label}
      </label>
      {children}
      {helper && !error && <p className="text-[13px] leading-relaxed text-tint-muted/80">{helper}</p>}
      {error && (
        <p role="alert" className="text-[13px] leading-relaxed text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

export function ErrorAlert({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm leading-relaxed text-red-200"
    >
      {message}
    </p>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-8">
      <h3 className="text-lg font-semibold tracking-tight text-white">{title}</h3>
      <p className="max-w-[65ch] text-sm leading-relaxed text-tint-muted">{body}</p>
      {action}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`tint-shimmer rounded-xl ${className}`} />;
}

/** Input de TINT: translúcido, rounded-xl y con anillo de foco cálido y suave. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className = '', ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      {...rest}
      className={`w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] backdrop-blur-sm transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-tint-muted/50 hover:border-white/15 focus:border-tint-accent/60 focus:bg-white/[0.05] focus:outline-none focus:ring-2 focus:ring-tint-accent/25 ${className}`}
    />
  );
});
