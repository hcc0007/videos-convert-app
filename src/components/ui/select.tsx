import * as SelectPrimitive from "@rn-primitives/select/dist/select.js";
import { Check, ChevronDown } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Platform, Pressable, Text, View } from "react-native";
import { cn } from "../../lib/cn";
import { VIDEO_FORMATS } from "../../lib/formats";

type FormatSelectProps = {
  value?: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
};

type AnchorBox = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

const MENU_ITEM_HEIGHT = 44;

function FormatSelect({ value, onChange, placeholder, disabled }: FormatSelectProps) {
  const triggerRef = useRef<SelectPrimitive.TriggerRef>(null);
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<AnchorBox | null>(null);
  const selected = VIDEO_FORMATS.find((format) => format.id === value);

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const update = () => {
      anchorRef.current?.measureInWindow((x, y, width, height) => {
        const menuHeight = VIDEO_FORMATS.length * MENU_ITEM_HEIGHT + 10;
        const top = y + height + 4;
        let maxHeight = menuHeight;
        if (Platform.OS === "web" && typeof window !== "undefined") {
          maxHeight = Math.min(menuHeight, Math.max(120, window.innerHeight - top - 12));
        }
        setBox({ top, left: x, width, maxHeight });
      });
    };
    update();
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onMove = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  const close = () => triggerRef.current?.close();

  const menu =
    open && box && box.width > 0 ? (
      <View
        pointerEvents="box-none"
        style={{
          position: (Platform.OS === "web" ? "fixed" : "absolute") as "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 80,
        }}
      >
        <Pressable
          accessibilityLabel="关闭格式列表"
          onPress={close}
          style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
        />
        <View
          style={{
            position: "absolute",
            top: box.top,
            left: box.left,
            width: box.width,
            maxHeight: box.maxHeight,
            zIndex: 1,
            overflow: "auto",
            borderRadius: 12,
            borderWidth: 1,
            borderColor: "#e4dccb",
            backgroundColor: "#fffdf8",
            paddingVertical: 4,
            shadowColor: "#1c1915",
            shadowOpacity: 0.16,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: 10 },
            elevation: 12,
          }}
        >
          {VIDEO_FORMATS.map((format) => {
            const active = format.id === value;
            return (
              <Pressable
                key={format.id}
                onPress={() => {
                  onChange(format.id);
                  close();
                }}
                className={cn(
                  "mx-1 my-px flex-row items-center justify-between rounded-lg px-2.5 py-2",
                  active ? "bg-[#e7f4ef] hover:bg-[#d3ebe2]" : "hover:bg-paper active:bg-paper",
                )}
              >
                <Text className={cn("text-base", active ? "font-semibold text-pine" : "text-ink")}>
                  {format.label}
                </Text>
                {active ? <Check size={16} color="#0f6e56" /> : null}
              </Pressable>
            );
          })}
        </View>
      </View>
    ) : null;

  return (
    <View ref={anchorRef} collapsable={false} className="relative z-10 self-stretch">
      <SelectPrimitive.Root
        value={selected ? { value: selected.id, label: selected.label } : undefined}
        onValueChange={(option) => {
          if (option?.value) onChange(option.value);
        }}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setBox(null);
        }}
        disabled={disabled}
      >
        <SelectPrimitive.Trigger
          ref={triggerRef}
          disabled={disabled}
          className={cn(
            "h-12 flex-row items-center justify-between self-stretch rounded-xl border border-line bg-white px-3",
            disabled && "opacity-50",
          )}
        >
          <Text className={cn("text-base", selected ? "text-ink" : "text-muted")}>
            {selected?.label ?? placeholder}
          </Text>
          <ChevronDown size={18} color="#6d6458" />
        </SelectPrimitive.Trigger>
      </SelectPrimitive.Root>
      {menu && Platform.OS === "web" && typeof document !== "undefined"
        ? createPortal(menu, document.body)
        : menu}
    </View>
  );
}

export { FormatSelect };
