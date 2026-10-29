import * as ProgressPrimitive from "@rn-primitives/progress/dist/progress.js";
import { cn } from "../../lib/cn";

type ProgressProps = ProgressPrimitive.RootProps & {
  indicatorClassName?: string;
};

function Progress({ className, value, indicatorClassName, ...props }: ProgressProps) {
  const amount = typeof value === "number" ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <ProgressPrimitive.Root
      value={amount}
      max={100}
      className={cn("h-2 overflow-hidden rounded-full bg-line", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn("h-full rounded-full bg-pine", indicatorClassName)}
        style={{ width: `${amount}%` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
