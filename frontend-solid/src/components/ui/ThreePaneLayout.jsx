import { createSignal, onCleanup } from "solid-js";
import { clsx } from "clsx";

export const ThreePaneLayout = (props) => {
    // Initial widths in percentages: Left (25%), Right (25%). Center fills the rest.
    const [leftWidth, setLeftWidth] = createSignal(25);
    const [rightWidth, setRightWidth] = createSignal(25);
    const [isDragging, setIsDragging] = createSignal(null); // 'left' | 'right' | null

    let containerRef;

    const handleMouseDown = (side) => (e) => {
        e.preventDefault();
        setIsDragging(side);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    };

    const handleMouseMove = (e) => {
        if (!isDragging() || !containerRef) return;

        const containerRect = containerRef.getBoundingClientRect();
        const containerWidth = containerRect.width;
        const x = e.clientX - containerRect.left;

        // Convert pixel position to percentage
        const percentage = (x / containerWidth) * 100;

        if (isDragging() === 'left') {
            // Constraints for left pane (min 15%, max 45%)
            const newWidth = Math.min(Math.max(percentage, 15), 45);
            setLeftWidth(newWidth);
        } else if (isDragging() === 'right') {
            // Constraints for right pane (min 15%, max 45%)
            // Right width is measured from the right edge, so it's (100 - percentage)
            const newWidth = Math.min(Math.max(100 - percentage, 15), 45);
            setRightWidth(newWidth);
        }
    };

    const handleMouseUp = () => {
        setIsDragging(null);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
    };

    // Global event listeners for drag
    // We attach these to window to catch mouse moves outside the handle
    if (typeof window !== "undefined") {
        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
    }

    onCleanup(() => {
        if (typeof window !== "undefined") {
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);
        }
    });

    return (
        <div
            ref={containerRef}
            class="flex h-full w-full overflow-hidden bg-bb-border select-none"
        >
            {/* Left Pane */}
            <div style={{ width: `${leftWidth()}%` }} class="h-full bg-bb-bg min-w-0">
                {props.left}
            </div>

            {/* Left Handle */}
            <div
                onMouseDown={handleMouseDown('left')}
                class={clsx(
                    "w-px h-full relative z-50 bg-bb-border transition-colors hover:bg-bb-accent",
                    isDragging() === 'left' ? "bg-bb-accent" : ""
                )}
            >
                {/* Invisible hit area for easier grabbing */}
                <div class="absolute inset-y-0 -left-1 w-3 cursor-col-resize z-50"></div>
            </div>

            {/* Center Pane (Flex 1 fills remaining space) */}
            <div class="flex-1 h-full bg-bb-bg min-w-0">
                {props.center}
            </div>

            {/* Right Handle */}
            <div
                onMouseDown={handleMouseDown('right')}
                class={clsx(
                    "w-px h-full relative z-50 bg-bb-border transition-colors hover:bg-bb-accent",
                    isDragging() === 'right' ? "bg-bb-accent" : ""
                )}
            >
                {/* Invisible hit area for easier grabbing */}
                <div class="absolute inset-y-0 -left-1 w-3 cursor-col-resize z-50"></div>
            </div>

            {/* Right Pane */}
            <div style={{ width: `${rightWidth()}%` }} class="h-full bg-bb-bg min-w-0">
                {props.right}
            </div>
        </div>
    );
};
