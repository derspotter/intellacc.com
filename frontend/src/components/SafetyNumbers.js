// frontend/src/components/SafetyNumbers.js
// Safety Numbers UI for verifying E2EE identity (MITM protection)
import van from 'vanjs-core';
const { div, h3, h4, p, span, button, pre, code } = van.tags;
import coreCryptoClient from '../services/mls/coreCryptoClient.js';

/**
 * Safety Numbers Modal Component
 * Displays cryptographic fingerprints for out-of-band verification
 * @param {Object} props
 * @param {Function} props.onClose - Callback to close the modal
 * @param {string} props.otherUserId - Optional: other user's ID to compare with
 * @param {string} props.otherUserName - Optional: other user's display name
 */
export function SafetyNumbersModal({ onClose, otherUserId, otherUserName }) {
    const showNumeric = van.state(false);
    const copied = van.state(false);

    // Get current user's fingerprint
    const fingerprint = coreCryptoClient.getIdentityFingerprint();
    const formattedHex = coreCryptoClient.formatFingerprint(fingerprint);
    const formattedNumeric = coreCryptoClient.fingerprintToNumeric(fingerprint);

    const copyToClipboard = async () => {
        const text = showNumeric.val ? formattedNumeric : formattedHex;
        try {
            await navigator.clipboard.writeText(text.replace(/\s/g, ''));
            copied.val = true;
            setTimeout(() => { copied.val = false; }, 2000);
        } catch (e) {
            console.error('Failed to copy:', e);
        }
    };

    return div({ class: "modal-overlay", onclick: (e) => {
        if (e.target.classList.contains('modal-overlay')) onClose();
    }}, [
        div({ class: "modal safety-numbers-modal" }, [
            div({ class: "modal-header" }, [
                h3("Safety Numbers"),
                button({ class: "btn-close", onclick: onClose }, "\u00D7")
            ]),

            div({ class: "modal-body" }, [
                div({ class: "safety-info" }, [
                    p({ class: "safety-description" },
                        "Compare these numbers with your contact to verify your messages are end-to-end encrypted. " +
                        "If they match, no one is intercepting your communication."
                    )
                ]),

                // Your fingerprint section
                div({ class: "fingerprint-section" }, [
                    h4("Your Safety Number"),
                    div({ class: "fingerprint-display" }, [
                        () => div({ class: "fingerprint-grid" },
                            showNumeric.val
                                ? formatNumericGrid(formattedNumeric)
                                : formatHexGrid(formattedHex)
                        )
                    ]),

                    div({ class: "fingerprint-actions" }, [
                        button({
                            class: () => `btn btn-sm ${showNumeric.val ? '' : 'btn-primary'}`,
                            onclick: () => { showNumeric.val = false; }
                        }, "Hex"),
                        button({
                            class: () => `btn btn-sm ${showNumeric.val ? 'btn-primary' : ''}`,
                            onclick: () => { showNumeric.val = true; }
                        }, "Numeric"),
                        button({
                            class: "btn btn-sm btn-secondary",
                            onclick: copyToClipboard
                        }, () => copied.val ? "Copied!" : "Copy")
                    ])
                ]),

                // Verification instructions
                div({ class: "verification-instructions" }, [
                    h4("How to Verify"),
                    div({ class: "instruction-steps" }, [
                        div({ class: "step" }, [
                            span({ class: "step-number" }, "1"),
                            span("Meet your contact in person or call them")
                        ]),
                        div({ class: "step" }, [
                            span({ class: "step-number" }, "2"),
                            span("Compare these numbers - they should match exactly")
                        ]),
                        div({ class: "step" }, [
                            span({ class: "step-number" }, "3"),
                            span("If they don't match, your connection may be compromised")
                        ])
                    ])
                ]),

                // Warning about key changes
                div({ class: "safety-warning" }, [
                    span({ class: "warning-icon" }, "\u26A0"),
                    span("Safety numbers change when you or your contact reinstall the app or switch devices.")
                ])
            ])
        ])
    ]);
}

/**
 * Format hex fingerprint into a visual grid
 */
function formatHexGrid(formatted) {
    if (!formatted) return [p("No fingerprint available")];
    const groups = formatted.split(' ');
    const rows = [];
    for (let i = 0; i < groups.length; i += 4) {
        rows.push(
            div({ class: "fingerprint-row" },
                groups.slice(i, i + 4).map(g =>
                    span({ class: "fingerprint-group hex" }, g)
                )
            )
        );
    }
    return rows;
}

/**
 * Format numeric fingerprint into a visual grid
 */
function formatNumericGrid(formatted) {
    if (!formatted) return [p("No fingerprint available")];
    const groups = formatted.split(' ');
    const rows = [];
    for (let i = 0; i < groups.length; i += 4) {
        rows.push(
            div({ class: "fingerprint-row" },
                groups.slice(i, i + 4).map(g =>
                    span({ class: "fingerprint-group numeric" }, g)
                )
            )
        );
    }
    return rows;
}

/**
 * Small button to show Safety Numbers (for use in chat header)
 */
export function SafetyNumbersButton() {
    const showModal = van.state(false);

    return div({ class: "safety-numbers-trigger" }, [
        button({
            class: "btn btn-sm btn-icon",
            title: "Verify Safety Numbers",
            onclick: () => { showModal.val = true; }
        }, [
            span({ class: "shield-icon" }, "\uD83D\uDEE1"),
            span({ class: "btn-text" }, "Verify")
        ]),
        // Use a container div that conditionally shows modal content
        () => {
            if (!showModal.val) return div({ style: "display:none" });
            return SafetyNumbersModal({
                onClose: () => { showModal.val = false; }
            });
        }
    ]);
}

export default SafetyNumbersModal;
