import { createSignal, onMount, onCleanup, Show } from "solid-js";
import coreCryptoClient from "@shared/mls/coreCryptoClient.js";
import messagingStore from "../../store/messagingStore";
import { createFocusTrap, pushOverlay, popOverlay } from "../../utils/keyboard";

// Safety-number (TOFU fingerprint) inspection + verification for a DM.
// Rendered by both skins (MessagesPage and ChatPanel), terminal-styled like
// DeviceLinkModal. Fingerprints are SHA-256 of leaf signature public keys —
// the own value shown here is exactly what the contact's device recorded,
// so two people can compare numbers out-of-band.
export const SafetyNumberModal = (props) => {
    const [loading, setLoading] = createSignal(true);
    const [error, setError] = createSignal("");
    const [ownFingerprint, setOwnFingerprint] = createSignal("");
    const [contactFingerprint, setContactFingerprint] = createSignal("");
    const [record, setRecord] = createSignal(null); // vault TOFU record
    const [busy, setBusy] = createSignal(false);

    const contactName = () => props.contactName || `User ${props.contactUserId}`;
    const status = () => record()?.status || "unverified";

    const load = async () => {
        setLoading(true);
        setError("");
        try {
            const roster = await coreCryptoClient.getGroupFingerprints(props.groupId);
            const own = roster.find((entry) => entry.isSelf);
            const contact = roster.find((entry) => entry.userId === Number(props.contactUserId));
            setOwnFingerprint(own?.fingerprint || "");
            setContactFingerprint(contact?.fingerprint || "");

            const vault = await coreCryptoClient.getVaultService();
            setRecord((await vault?.getContactFingerprint?.(Number(props.contactUserId))) || null);
        } catch (e) {
            console.warn("[SafetyNumbers] Failed to load fingerprints:", e);
            setError(e?.message || "Failed to load safety numbers");
        } finally {
            setLoading(false);
        }
    };

    const markVerified = async () => {
        setBusy(true);
        try {
            await coreCryptoClient.verifyContact(Number(props.contactUserId));
            messagingStore.dismissFingerprintWarning?.(Number(props.contactUserId));
            await load();
            props.onStatusChange?.();
        } catch (e) {
            setError(e?.message || "Failed to mark as verified");
        } finally {
            setBusy(false);
        }
    };

    const unverify = async () => {
        setBusy(true);
        try {
            await coreCryptoClient.unverifyContact(Number(props.contactUserId));
            await load();
            props.onStatusChange?.();
        } catch (e) {
            setError(e?.message || "Failed to remove verification");
        } finally {
            setBusy(false);
        }
    };

    let panelRef;
    let disposeTrap;
    let invoker;

    const close = () => props.onClose?.();

    const handlePanelKeydown = (e) => {
        // Same skin caveat as DeviceLinkModal: the terminal skin never
        // installs the van keyboard registry, so handle Escape locally and
        // stop propagation to avoid a double-close in the van skin.
        if (e.key === "Escape") {
            e.stopPropagation();
            close();
        }
    };

    onMount(() => {
        invoker = document.activeElement;
        pushOverlay(close);
        disposeTrap = createFocusTrap(panelRef);
        panelRef.querySelector("button")?.focus();
        void load();
    });
    onCleanup(() => {
        popOverlay();
        disposeTrap?.();
        invoker?.focus?.();
    });

    const format = (fp) => coreCryptoClient.formatFingerprint(fp);

    return (
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 font-mono">
            <div
                class="safety-numbers-modal w-full max-w-md mx-4 border border-bb-border bg-bb-panel shadow-glow-red"
                role="dialog"
                aria-modal="true"
                aria-label="Safety numbers"
                ref={panelRef}
                onKeyDown={handlePanelKeydown}
            >
                <div class="border-b border-bb-border px-4 py-3 flex items-center gap-2">
                    <span class="text-bb-accent font-bold text-xs">SAFETY NUMBERS // {contactName().toUpperCase()}</span>
                </div>

                <div class="p-4 flex flex-col gap-3 text-xs">
                    <Show when={loading()}>
                        <div class="loading-state text-bb-muted text-center py-4">LOADING FINGERPRINTS...</div>
                    </Show>

                    <Show when={!loading()}>
                        <Show when={error()}>
                            <div class="error-state text-market-down">{error()}</div>
                        </Show>

                        <div class="text-bb-muted text-[10px] leading-relaxed">
                            COMPARE THESE NUMBERS WITH {contactName().toUpperCase()} OVER A TRUSTED CHANNEL
                            (IN PERSON, PHONE CALL). IF THEY MATCH, MARK THE CONTACT AS VERIFIED.
                        </div>

                        <div class="fingerprint-section yours border border-bb-border/60 p-2">
                            <div class="text-bb-muted text-[10px] mb-1">YOUR SAFETY NUMBER</div>
                            <code class="fingerprint-display fingerprint-group hex block break-all text-bb-text bg-black px-2 py-1">
                                {format(ownFingerprint()) || "UNAVAILABLE"}
                            </code>
                        </div>

                        <div class="fingerprint-section theirs border border-bb-border/60 p-2">
                            <div class="text-bb-muted text-[10px] mb-1">{contactName().toUpperCase()}'S SAFETY NUMBER</div>
                            <code class="fingerprint-display fingerprint-group hex block break-all text-bb-accent bg-black px-2 py-1">
                                {format(contactFingerprint() || record()?.fingerprint) || "UNAVAILABLE"}
                            </code>
                        </div>

                        <Show when={status() === "changed"}>
                            <div class="safety-warning text-market-down border border-market-down/40 bg-market-down/10 p-2 text-[10px]">
                                WARNING: {contactName().toUpperCase()}'S ENCRYPTION KEY HAS CHANGED SINCE YOU LAST
                                VERIFIED IT. THIS CAN MEAN A REINSTALL OR A NEW DEVICE — OR AN ATTACK. RE-COMPARE
                                BEFORE TRUSTING.
                                <Show when={record()?.previousFingerprint}>
                                    <div class="mt-1 text-bb-muted break-all">
                                        PREVIOUS: {format(record().previousFingerprint)}
                                    </div>
                                </Show>
                            </div>
                        </Show>

                        <div class="verification-status flex items-center justify-between gap-2 pt-2 border-t border-bb-border/50">
                            <span
                                class="text-[10px]"
                                classList={{
                                    "text-market-up": status() === "verified",
                                    "text-market-down": status() === "changed",
                                    "text-bb-muted": status() === "unverified"
                                }}
                            >
                                STATUS: {status().toUpperCase()}
                            </span>
                            <Show
                                when={status() !== "verified"}
                                fallback={
                                    <button
                                        type="button"
                                        class="unverify-contact-btn bg-bb-bg border border-bb-border text-bb-muted px-3 py-1 text-[10px] hover:text-bb-text hover:border-bb-text transition-colors"
                                        disabled={busy()}
                                        onClick={() => void unverify()}
                                    >
                                        REMOVE VERIFICATION
                                    </button>
                                }
                            >
                                <button
                                    type="button"
                                    class="verify-contact-btn bg-bb-accent text-bb-bg font-bold px-3 py-1 text-[10px] hover:brightness-110"
                                    disabled={busy() || !contactFingerprint()}
                                    onClick={() => void markVerified()}
                                >
                                    MARK AS VERIFIED
                                </button>
                            </Show>
                        </div>
                    </Show>
                </div>

                <div class="border-t border-bb-border px-4 py-3 flex items-center justify-end">
                    <button
                        type="button"
                        onClick={close}
                        class="bg-bb-bg border border-bb-border text-bb-muted px-3 py-1 text-[10px] hover:text-bb-text hover:border-bb-text transition-colors"
                    >
                        CLOSE
                    </button>
                </div>
            </div>
        </div>
    );
};

export default SafetyNumberModal;
