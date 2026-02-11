import { mergeProps } from "solid-js";
import { clsx } from "clsx";

export const Panel = (props) => {
    const merged = mergeProps({ class: "" }, props);

    return (
        <div class={clsx(
            "bg-bb-panel border border-bb-border relative flex flex-col overflow-hidden",
            merged.class
        )}>
            {/* Header Bar */}
            {props.title && (
                <div class="bg-bb-accent text-black font-bold px-2 py-0.5 text-xs font-mono uppercase border-b border-bb-border flex justify-between items-center select-none shrink-0">
                    <span>{props.title}</span>
                    {props.headerActions}
                </div>
            )}
            <div class="flex-1 flex flex-col overflow-auto custom-scrollbar">
                {props.children}
            </div>
        </div>
    );
};
