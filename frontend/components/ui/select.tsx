"use client";

import { ChevronDown } from "lucide-react";
import {
  Button as AriaButton,
  type ButtonProps as AriaButtonProps,
  ListBox as AriaListBox,
  type ListBoxProps as AriaListBoxProps,
  ListBoxItem as AriaListBoxItem,
  Popover as AriaPopover,
  type PopoverProps as AriaPopoverProps,
  Select as AriaSelect,
  type SelectProps as AriaSelectProps,
  SelectValue as AriaSelectValue,
  type SelectValueProps as AriaSelectValueProps,
  composeRenderProps,
  Label,
} from "react-aria-components";

import { cn } from "@/lib/utils";

const Select = AriaSelect;

const SelectItem = ({ className, ...props }: any) => (
  <AriaListBoxItem
    className={composeRenderProps(className, (className) =>
      cn(
        "relative flex w-full cursor-pointer select-none items-center rounded-sm py-2 px-3 text-sm outline-none transition-colors bg-white dark:bg-gray-800",
        /* Hover */
        "data-[hovered]:bg-gray-200 dark:data-[hovered]:bg-gray-700",
        /* Focus */
        "data-[focused]:bg-gray-200 dark:data-[focused]:bg-gray-700",
        /* Selected */
        "data-[selected]:bg-black data-[selected]:text-white dark:data-[selected]:bg-white dark:data-[selected]:text-black",
        /* Disabled */
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )
    )}
    {...props}
  />
);

// Optional helpers omitted to avoid version/export mismatches

const SelectValue = <T extends object>({
  className,
  ...props
}: AriaSelectValueProps<T>) => (
  <AriaSelectValue
    className={composeRenderProps(className, (className) =>
      cn(
        "line-clamp-1 data-[placeholder]:text-muted-foreground",
        /* Description */
        "[&>[slot=description]]:hidden",
        className
      )
    )}
    {...props}
  />
);

const SelectTrigger = ({ className, children, ...props }: AriaButtonProps) => (
  <AriaButton
    className={composeRenderProps(className, (className) =>
      cn(
        "flex h-10 w-full items-center justify-between rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm",
        /* Disabled */
        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        /* Focused */
        "data-[focus-visible]:outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-gray-400 dark:data-[focus-visible]:ring-gray-500",
        /* Resets */
        "focus-visible:outline-none",
        className
      )
    )}
    {...props}
  >
    {composeRenderProps(children, (children) => (
      <>
        {children}
        <ChevronDown aria-hidden="true" className="size-4 opacity-50" />
      </>
    ))}
  </AriaButton>
);

const SelectPopover = ({ className, ...props }: AriaPopoverProps) => (
  <AriaPopover
    className={composeRenderProps(className, (className) =>
      cn(
        "w-[--trigger-width] z-50 min-w-[8rem] overflow-hidden rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg",
        className
      )
    )}
    {...props}
  />
);

const SelectListBox = <T extends object>({
  className,
  ...props
}: AriaListBoxProps<T>) => (
  <AriaListBox
    className={composeRenderProps(className, (className) =>
      cn(
        "max-h-[300px] overflow-auto p-1 outline-none",
        className
      )
    )}
    {...props}
  />
);

interface JollySelectProps<T extends object>
  extends Omit<AriaSelectProps<T>, "children"> {
  label?: string;
  items?: Iterable<T>;
  children: React.ReactNode | ((item: T) => React.ReactNode);
}

function JollySelect<T extends object>({
  label,
  children,
  className,
  items,
  ...props
}: JollySelectProps<T>) {
  return (
    <Select
      className={composeRenderProps(className, (className) =>
        cn("group flex flex-col gap-2", className)
      )}
      {...props}
    >
      {label && <Label>{label}</Label>}
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectPopover>
        <SelectListBox items={items}>{children}</SelectListBox>
      </SelectPopover>
    </Select>
  );
}

export {
  Select,
  SelectValue,
  SelectTrigger,
  SelectItem,
  SelectPopover,
  SelectListBox,
  JollySelect,
};
export type { JollySelectProps };
