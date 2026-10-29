import * as DialogPrimitive from "@rn-primitives/dialog/dist/dialog.js";
import { Platform, Text, View } from "react-native";
import { cn } from "../../lib/cn";

const coverClass = Platform.OS === "web" ? "fixed inset-0" : "absolute inset-0";

function Dialog(props: DialogPrimitive.RootProps) {
  return <DialogPrimitive.Root {...props} />;
}

function DialogOverlay({ className, ...props }: DialogPrimitive.OverlayProps) {
  return (
    <DialogPrimitive.Overlay
      className={cn(coverClass, "bg-ink/45", className)}
      {...props}
    />
  );
}

function DialogContent({ className, children, ...props }: DialogPrimitive.ContentProps) {
  const { open } = DialogPrimitive.useRootContext();
  if (!open) return null;
  return (
    <View className={cn(coverClass, "z-50 items-center justify-center")} pointerEvents="box-none">
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          "z-10 w-[340px] rounded-2xl border border-line bg-card px-6 py-7 shadow-xl",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </View>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.TitleProps) {
  return (
    <DialogPrimitive.Title
      className={cn("text-center text-2xl font-semibold text-ink", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.DescriptionProps) {
  return (
    <DialogPrimitive.Description
      className={cn("mt-2 text-center text-base leading-6 text-muted", className)}
      {...props}
    />
  );
}

function DialogClose({ className, children, ...props }: DialogPrimitive.CloseProps) {
  return (
    <DialogPrimitive.Close
      className={cn("mt-6 items-center rounded-xl bg-pine px-4 py-3 active:bg-pineDeep", className)}
      {...props}
    >
      {typeof children === "string" ? (
        <Text className="text-base font-semibold text-white">{children}</Text>
      ) : (
        children
      )}
    </DialogPrimitive.Close>
  );
}

export { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle };
