// flow-button.tsx
// Pill button whose arrow flows across while a circle fills it on hover.
// Copied from the shared FlowButton component. Additions (the default look is unchanged):
// `tone="light"` for dark backgrounds, `href` to render a link, and pass-through props.
import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "dark" | "light";

type CommonProps = { text?: string; tone?: Tone; className?: string };
type AsButton = CommonProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { href?: undefined };
type AsLink = CommonProps & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children"> & { href: string };
export type FlowButtonProps = AsButton | AsLink;

const tones: Record<Tone, { root: string; arrow: string; circle: string }> = {
  dark: {
    root: "border-[#333333]/40 text-[#111111] hover:text-white",
    arrow: "stroke-[#111111] group-hover:stroke-white",
    circle: "bg-[#111111]",
  },
  light: {
    root: "border-[#f5f1ec]/45 text-[#f5f1ec] hover:text-[#2e2e2e]",
    arrow: "stroke-[#f5f1ec] group-hover:stroke-[#2e2e2e]",
    circle: "bg-[#e08d6d]",
  },
};

export function FlowButton({ text = "Modern Button", tone = "dark", className, ...rest }: FlowButtonProps) {
  const t = tones[tone];
  const classes = cn(
    "group relative inline-flex items-center gap-1 overflow-hidden rounded-[100px] border-[1.5px] bg-transparent px-8 py-3 text-sm font-semibold no-underline cursor-pointer transition-all duration-[600ms] ease-[cubic-bezier(0.23,1,0.32,1)] hover:border-transparent hover:rounded-[12px] active:scale-[0.95] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--copper)] motion-reduce:transition-none",
    t.root,
    className,
  );

  const inner = (
    <>
      {/* Left arrow (arr-2) */}
      <ArrowRight
        aria-hidden="true"
        className={cn(
          "absolute w-4 h-4 left-[-25%] fill-none z-[9] group-hover:left-4 transition-all duration-[800ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]",
          t.arrow,
        )}
      />

      {/* Text */}
      <span className="relative z-[1] -translate-x-3 group-hover:translate-x-3 transition-all duration-[800ms] ease-out">
        {text}
      </span>

      {/* Circle (320px rather than 220px so longer labels are fully covered) */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-[50%] opacity-0 group-hover:w-[320px] group-hover:h-[320px] group-hover:opacity-100 transition-all duration-[800ms] ease-[cubic-bezier(0.19,1,0.22,1)]",
          t.circle,
        )}
      ></span>

      {/* Right arrow (arr-1) */}
      <ArrowRight
        aria-hidden="true"
        className={cn(
          "absolute w-4 h-4 right-4 fill-none z-[9] group-hover:right-[-25%] transition-all duration-[800ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]",
          t.arrow,
        )}
      />
    </>
  );

  if (rest.href !== undefined) {
    return (
      <a className={classes} {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)}>
        {inner}
      </a>
    );
  }
  const { type = "button", ...buttonProps } = rest as ButtonHTMLAttributes<HTMLButtonElement>;
  return (
    <button type={type} className={classes} {...buttonProps}>
      {inner}
    </button>
  );
}
