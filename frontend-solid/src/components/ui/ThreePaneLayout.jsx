import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { clsx } from "clsx";

export const ThreePaneLayout = (props) => {
    // Initial widths in percentages: Left (25%), Right (25%). Center fills the rest.
    const [leftWidth, setLeftWidth] = createSignal(25);
    const [rightWidth, setRightWidth] = createSignal(25);
    const [isDragging, setIsDragging] = createSignal(null); // 'left' | 'right' | null

    let containerEl;
    let moveHandler = null;
    let upHandler = null;

    const tabletShowLeft = () => props.activePane !== 3;
    const tabletShowRight = () => props.activePane === 3;

    const stopDrag = () => {
        setIsDragging(null);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        if (moveHandler) window.removeEventListener("pointermove", moveHandler);
        if (upHandler) window.removeEventListener("pointerup", upHandler);
        moveHandler = null;
        upHandler = null;
    };

    const startDrag = (side) => (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!containerEl) return;

        setIsDragging(side);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";

        moveHandler = (ev) => {
            if (!isDragging() || !containerEl) return;

            const containerRect = containerEl.getBoundingClientRect();
            const containerWidth = containerRect.width;
            const x = ev.clientX - containerRect.left;

            // Convert pixel position to percentage
            const percentage = (x / containerWidth) * 100;

            if (isDragging() === "left") {
                // Constraints for left pane (min 15%, max 45%)
                const newWidth = Math.min(Math.max(percentage, 15), 45);
                setLeftWidth(newWidth);
            } else if (isDragging() === "right") {
                // Right width is measured from the right edge, so it's (100 - percentage)
                const newWidth = Math.min(Math.max(100 - percentage, 15), 45);
                setRightWidth(newWidth);
            }
        };

        upHandler = () => stopDrag();

        window.addEventListener("pointermove", moveHandler);
        window.addEventListener("pointerup", upHandler);
    };

    onMount(() => {
        // Ensure we always clean up if the component unmounts mid-drag (HMR, route change, etc).
        onCleanup(() => stopDrag());
    });

    return (
        <div class="h-full w-full overflow-hidden bg-bb-border">
            {/* Mobile (< md): show ONE pane at a time */}
            <div class="md:hidden h-full w-full overflow-hidden">
                <Show when={props.activePane === 1}>
                    <div class="h-full w-full bg-bb-bg min-w-0 relative">
                        {props.left}
                        <div class="absolute inset-0 border-2 border-bb-accent pointer-events-none z-20 shadow-[inset_0_0_15px_rgba(255,152,0,0.1)]"></div>
                    </div>
                </Show>
                <Show when={props.activePane === 2}>
                    <div class="h-full w-full bg-bb-bg min-w-0 relative">
                        {props.center}
                        <div class="absolute inset-0 border-2 border-bb-accent pointer-events-none z-20 shadow-[inset_0_0_15px_rgba(255,152,0,0.1)]"></div>
                    </div>
                </Show>
                <Show when={props.activePane === 3}>
                    <div class="h-full w-full bg-bb-bg min-w-0 relative">
                        {props.right}
                        <div class="absolute inset-0 border-2 border-bb-accent pointer-events-none z-20 shadow-[inset_0_0_15px_rgba(255,152,0,0.1)]"></div>
                    </div>
                </Show>
            </div>

            {/* Tablet (md..lg): show TWO panes, hide the third */}
            <div class="hidden md:flex lg:hidden h-full w-full overflow-hidden">
                <Show when={tabletShowLeft()}>
                    <div class="w-[340px] min-w-[280px] max-w-[380px] h-full bg-bb-bg min-w-0 relative">
                        {props.left}
                        <Show when={props.activePane === 1}>
                            <div class="absolute inset-0 border-2 border-bb-accent pointer-events-none z-20 shadow-[inset_0_0_15px_rgba(255,152,0,0.1)]"></div>
                        </Show>
                    </div>
                    <div class="w-px h-full bg-bb-border"></div>
                </Show>

                <div class="flex-1 h-full bg-bb-bg min-w-0 relative">
                    {props.center}
                    <Show when={props.activePane === 2}>
                        <div class="absolute inset-0 border-2 border-bb-accent pointer-events-none z-20 shadow-[inset_0_0_15px_rgba(255,152,0,0.1)]"></div>
                    </Show>
                </div>

                <Show when={tabletShowRight()}>
                    <div class="w-px h-full bg-bb-border"></div>
                    <div class="w-[340px] min-w-[280px] max-w-[380px] h-full bg-bb-bg min-w-0 relative">
                        {props.right}
                        <Show when={props.activePane === 3}>
                            <div class="absolute inset-0 border-2 border-bb-accent pointer-events-none z-20 shadow-[inset_0_0_15px_rgba(255,152,0,0.1)]"></div>
                        </Show>
                    </div>
                </Show>
            </div>

            {/* Desktop (>= lg): existing resizable 3-pane layout */}
            <div
                ref={(el) => (containerEl = el)}
                class="hidden lg:flex h-full w-full overflow-hidden bg-bb-border select-none"
            >
                {/* Left Pane */}
                <div
                    style={{ width: `${leftWidth()}%` }}
                    class="h-full bg-bb-bg min-w-0 relative transition-all duration-200"
                >
                    {props.left}
                    <Show when={props.activePane === 1}>
                        <div class="absolute inset-0 border-2 border-bb-accent pointer-events-none z-20 shadow-[inset_0_0_15px_rgba(255,152,0,0.1)]"></div>
                    </Show>
                </div>

                {/* Left Handle */}
                <div
                    onPointerDown={startDrag("left")}
                    class={clsx(
                        "w-px h-full relative z-50 bg-bb-border transition-colors hover:bg-bb-accent",
                        isDragging() === "left" ? "bg-bb-accent" : ""
                    )}
                >
                    <div class="absolute inset-y-0 -left-1 w-3 cursor-col-resize z-50 touch-none"></div>
                </div>

                {/* Center Pane (Flex 1 fills remaining space) */}
                <div class="flex-1 h-full bg-bb-bg min-w-0 relative transition-all duration-200">
                    {props.center}
                    <Show when={props.activePane === 2}>
                        <div class="absolute inset-0 border-2 border-bb-accent pointer-events-none z-20 shadow-[inset_0_0_15px_rgba(255,152,0,0.1)]"></div>
                    </Show>
                </div>

                {/* Right Handle */}
                <div
                    onPointerDown={startDrag("right")}
                    class={clsx(
                        "w-px h-full relative z-50 bg-bb-border transition-colors hover:bg-bb-accent",
                        isDragging() === "right" ? "bg-bb-accent" : ""
                    )}
                >
                    <div class="absolute inset-y-0 -left-1 w-3 cursor-col-resize z-50 touch-none"></div>
                </div>

                {/* Right Pane */}
                <div
                    style={{ width: `${rightWidth()}%` }}
                    class="h-full bg-bb-bg min-w-0 relative transition-all duration-200"
                >
                    {props.right}
                    <Show when={props.activePane === 3}>
                        <div class="absolute inset-0 border-2 border-bb-accent pointer-events-none z-20 shadow-[inset_0_0_15px_rgba(255,152,0,0.1)]"></div>
                    </Show>
                </div>
            </div>
        </div>
    );
};
