import { createSignal, createEffect, on, onCleanup, Show } from "solid-js";
import vaultStore from "../../store/vaultStore";
import { api } from "../../services/api";
import { getPendingDeviceId, setPendingDeviceId, clearPendingDeviceId } from "../../services/deviceIdStore";

const getDevicePublicId = () => {
    let id = getPendingDeviceId();
    if (!id) {
        id = window.crypto?.randomUUID ? window.crypto.randomUUID() : `dev-${Date.now()}`;
        setPendingDeviceId(id);
    }
    return id;
};

const getDeviceName = () => {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return "iPhone";
    if (/iPad/.test(ua)) return "iPad";
    if (/Android/.test(ua)) return "Android Device";
    if (/Mac/.test(ua)) return "Mac";
    if (/Windows/.test(ua)) return "Windows PC";
    if (/Linux/.test(ua)) return "Linux PC";
    return "New Device";
};

const formatToken = (token) => {
    if (!token) return "";
    const short = token.slice(0, 12).toUpperCase();
    return short.match(/.{1,3}/g)?.join("-") || short;
};

export const DeviceLinkModal = (props) => {
    const [status, setStatus] = createSignal("init"); // init, loading, waiting, approved, error
    const [linkToken, setLinkToken] = createSignal("");
    const [expiresAt, setExpiresAt] = createSignal(null);
    const [error, setError] = createSignal("");
    const [timeRemaining, setTimeRemaining] = createSignal("");

    let pollTimer = null;
    let countdownTimer = null;

    const cleanupTimers = () => {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    };

    const startLinking = async () => {
        console.log("[DeviceLink] Starting linking process...");
        setStatus("loading");
        setError("");

        try {
            const devicePublicId = getDevicePublicId();
            console.log("[DeviceLink] Calling API with device:", devicePublicId);
            const result = await api.devices.startLinking(devicePublicId, getDeviceName());
            console.log("[DeviceLink] Got token:", result.token);
            setLinkToken(result.token);
            setExpiresAt(new Date(result.expires_at));

            setStatus("waiting");
            startPolling();
            startCountdown();
        } catch (e) {
            console.error("[DeviceLink] Failed to start linking:", e);
            setError(e.message || "Failed to start device verification");
            setStatus("error");
        }
    };

    const startPolling = () => {
        if (pollTimer) clearInterval(pollTimer);

        pollTimer = setInterval(async () => {
            try {
                const result = await api.devices.getLinkingStatus(linkToken());
                if (result.approved) {
                    cleanupTimers();
                    setStatus("approved");
                    handleApproved();
                }
            } catch (e) {
                console.warn("[DeviceLink] Polling error:", e);
            }
        }, 3000);
    };

    const startCountdown = () => {
        if (countdownTimer) clearInterval(countdownTimer);

        const update = () => {
            const exp = expiresAt();
            if (!exp) return;
            const diff = exp - new Date();
            if (diff <= 0) {
                setTimeRemaining("Expired");
                setStatus("error");
                setError("Verification code expired. Please try again.");
                cleanupTimers();
                return;
            }
            const mins = Math.floor(diff / 60000);
            const secs = Math.floor((diff % 60000) / 1000);
            setTimeRemaining(`${mins}:${secs.toString().padStart(2, "0")}`);
        };
        update();
        countdownTimer = setInterval(update, 1000);
    };

    const handleApproved = async () => {
        try {
            // Persist approved device ID so api.js x-device-id header picks it up
            const approvedId = getPendingDeviceId();
            if (approvedId) {
                localStorage.setItem('device_public_id', approvedId);
            }
            clearPendingDeviceId();
            vaultStore.setShowDeviceLinkModal(false);
            if (props.onSuccess) {
                await props.onSuccess();
            }
        } catch (e) {
            console.error("[DeviceLink] Error after approval:", e);
        }
    };

    const handleCancel = () => {
        cleanupTimers();
        clearPendingDeviceId();
        if (props.onCancel) props.onCancel();
        vaultStore.setShowDeviceLinkModal(false);
    };

    const handleRetry = () => {
        setStatus("init");
        setError("");
        setTimeout(() => startLinking(), 0);
    };

    const copyToken = async () => {
        try {
            await navigator.clipboard.writeText(formatToken(linkToken()));
        } catch (e) {
            console.warn("[DeviceLink] Copy failed:", e);
        }
    };

    // Single effect: react to modal visibility changes only
    createEffect(on(
        () => vaultStore.state.showDeviceLinkModal,
        (show, prev) => {
            if (show && !prev) {
                // Modal just opened
                startLinking();
            } else if (!show && prev) {
                // Modal just closed
                cleanupTimers();
                setStatus("init");
                setLinkToken("");
                setError("");
                setTimeRemaining("");
            }
        },
        { defer: true }
    ));

    onCleanup(() => cleanupTimers());

    return (
        <Show when={vaultStore.state.showDeviceLinkModal}>
            <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 font-mono">
                <div class="w-full max-w-sm mx-4 border border-bb-border bg-bb-panel shadow-glow-red">
                    {/* Header */}
                    <div class="border-b border-bb-border px-4 py-3 flex items-center gap-2">
                        <span class="text-bb-accent font-bold text-xs">DEVICE VERIFICATION</span>
                    </div>

                    {/* Body */}
                    <div class="p-4">
                        {/* Loading */}
                        <Show when={status() === "loading" || status() === "init"}>
                            <div class="text-bb-muted text-xs text-center py-4">
                                INITIALIZING DEVICE VERIFICATION...
                            </div>
                        </Show>

                        {/* Waiting for approval */}
                        <Show when={status() === "waiting"}>
                            <div class="flex flex-col gap-3">
                                <div class="text-bb-muted text-[10px] leading-relaxed">
                                    THIS DEVICE NEEDS VERIFICATION BEFORE ACCESSING E2EE MESSAGES.
                                    ENTER THIS CODE ON A VERIFIED DEVICE:
                                </div>

                                <div class="flex items-center justify-center gap-2 py-3">
                                    <code class="text-bb-accent text-lg font-bold tracking-widest bg-black px-4 py-2 border border-bb-accent">
                                        {formatToken(linkToken())}
                                    </code>
                                    <button
                                        type="button"
                                        onClick={copyToken}
                                        class="bg-bb-bg border border-bb-border text-bb-muted px-2 py-2 text-[10px] hover:text-bb-accent hover:border-bb-accent transition-colors"
                                        title="Copy code"
                                    >
                                        COPY
                                    </button>
                                </div>

                                <div class="text-center text-[10px] text-bb-muted">
                                    EXPIRES IN: <span class="text-bb-accent font-bold">{timeRemaining()}</span>
                                </div>

                                <div class="border-t border-bb-border/50 pt-3 flex flex-col gap-2 text-[10px] text-bb-muted">
                                    <div class="font-bold text-bb-text">HOW TO VERIFY:</div>
                                    <div class="flex gap-2"><span class="text-bb-accent">[1]</span> OPEN APP ON A VERIFIED DEVICE</div>
                                    <div class="flex gap-2"><span class="text-bb-accent">[2]</span> GO TO SETTINGS &gt; DEVICES</div>
                                    <div class="flex gap-2"><span class="text-bb-accent">[3]</span> TAP "APPROVE NEW DEVICE" AND ENTER CODE</div>
                                </div>

                                <div class="text-center text-[10px] text-bb-muted animate-pulse mt-2">
                                    WAITING FOR APPROVAL...
                                </div>
                            </div>
                        </Show>

                        {/* Approved */}
                        <Show when={status() === "approved"}>
                            <div class="text-center py-4">
                                <div class="text-market-up text-lg font-bold mb-2">VERIFIED</div>
                                <div class="text-bb-muted text-xs">DEVICE APPROVED SUCCESSFULLY.</div>
                            </div>
                        </Show>

                        {/* Error */}
                        <Show when={status() === "error"}>
                            <div class="flex flex-col gap-3 py-2">
                                <div class="text-market-down text-xs text-center">
                                    {error() || "AN ERROR OCCURRED"}
                                </div>
                                <button
                                    type="button"
                                    onClick={handleRetry}
                                    class="bg-bb-accent text-bb-bg font-bold py-1 px-4 text-xs hover:brightness-110 mx-auto"
                                >
                                    &gt; TRY AGAIN
                                </button>
                            </div>
                        </Show>
                    </div>

                    {/* Footer */}
                    <div class="border-t border-bb-border px-4 py-3 flex items-center justify-between">
                        <button
                            type="button"
                            onClick={handleCancel}
                            class="bg-bb-bg border border-bb-border text-bb-muted px-3 py-1 text-[10px] hover:text-bb-text hover:border-bb-text transition-colors"
                        >
                            CANCEL
                        </button>
                        <span class="text-[9px] text-bb-muted">
                            SKIP TO BROWSE WITHOUT E2EE
                        </span>
                    </div>
                </div>
            </div>
        </Show>
    );
};

export default DeviceLinkModal;
