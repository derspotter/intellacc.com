// frontend/src/components/SafetyNumbers.js
// Safety Numbers UI for verifying E2EE identity (MITM protection)
import van from 'vanjs-core';
const { div, h3, h4, p, span, button, pre, code } = van.tags;
import coreCryptoClient from '@shared/mls/coreCryptoClient.js';

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

/**
 * Contact Verification Modal
 * Shows side-by-side comparison of your fingerprint and contact's fingerprint
 * @param {Object} props
 * @param {number} props.contactUserId - Contact's user ID
 * @param {string} props.contactUsername - Contact's display name
 * @param {Function} props.onClose - Callback to close modal
 * @param {Function} props.onVerify - Callback when contact is verified
 */
export function ContactVerificationModal({ contactUserId, contactUsername, onClose, onVerify }) {
    const loading = van.state(true);
    const myFingerprint = van.state('');
    const contactFingerprint = van.state('');
    const verificationStatus = van.state('unverified');
    const error = van.state(null);
    const showNumeric = van.state(false);
    const verifying = van.state(false);

    // Load fingerprints
    (async () => {
        try {
            // Get own fingerprint
            const my = coreCryptoClient.getIdentityFingerprint();
            myFingerprint.val = my || '';

            // Get contact's fingerprint from vault
            const contact = await coreCryptoClient.getContactFingerprint(contactUserId);
            if (contact) {
                contactFingerprint.val = contact.fingerprint || '';
                verificationStatus.val = contact.status || 'unverified';
            } else {
                error.val = 'No safety number recorded for this contact yet. Send or receive a message first.';
            }
        } catch (e) {
            console.error('[SafetyNumbers] Error loading fingerprints:', e);
            error.val = e.message || 'Failed to load safety numbers';
        } finally {
            loading.val = false;
        }
    })();

    const handleVerify = async () => {
        verifying.val = true;
        try {
            await coreCryptoClient.verifyContact(contactUserId);
            verificationStatus.val = 'verified';
            onVerify?.();
        } catch (e) {
            console.error('[SafetyNumbers] Error verifying contact:', e);
            error.val = e.message || 'Failed to verify contact';
        } finally {
            verifying.val = false;
        }
    };

    const handleUnverify = async () => {
        verifying.val = true;
        try {
            await coreCryptoClient.unverifyContact(contactUserId);
            verificationStatus.val = 'unverified';
        } catch (e) {
            console.error('[SafetyNumbers] Error unverifying contact:', e);
        } finally {
            verifying.val = false;
        }
    };

    const formatFingerprint = (fp) => {
        if (!fp) return '';
        return showNumeric.val
            ? coreCryptoClient.fingerprintToNumeric(fp)
            : coreCryptoClient.formatFingerprint(fp);
    };

    return div({ class: "modal-overlay", onclick: (e) => {
        if (e.target.classList.contains('modal-overlay')) onClose();
    }}, [
        div({ class: "modal safety-numbers-modal contact-verification" }, [
            div({ class: "modal-header" }, [
                h3(`Verify ${contactUsername || 'Contact'}`),
                button({ class: "btn-close", onclick: onClose }, "\u00D7")
            ]),

            div({ class: "modal-body" }, [
                () => {
                    if (loading.val) {
                        return div({ class: "loading-state" }, "Loading safety numbers...");
                    }

                    if (error.val && !contactFingerprint.val) {
                        return div({ class: "error-state" }, [
                            span({ class: "error-icon" }, "\u26A0"),
                            span(error.val)
                        ]);
                    }

                    return div({ class: "fingerprint-comparison" }, [
                        // Format toggle
                        div({ class: "format-toggle" }, [
                            button({
                                class: () => `btn btn-sm ${showNumeric.val ? '' : 'btn-primary'}`,
                                onclick: () => { showNumeric.val = false; }
                            }, "Hex"),
                            button({
                                class: () => `btn btn-sm ${showNumeric.val ? 'btn-primary' : ''}`,
                                onclick: () => { showNumeric.val = true; }
                            }, "Numeric")
                        ]),

                        // Your fingerprint
                        div({ class: "fingerprint-section yours" }, [
                            h4("Your Safety Number"),
                            div({ class: "fingerprint-display" }, [
                                () => div({ class: "fingerprint-grid" },
                                    showNumeric.val
                                        ? formatNumericGrid(formatFingerprint(myFingerprint.val))
                                        : formatHexGrid(formatFingerprint(myFingerprint.val))
                                )
                            ])
                        ]),

                        // Contact's fingerprint
                        div({ class: "fingerprint-section theirs" }, [
                            h4(`${contactUsername || 'Contact'}'s Safety Number`),
                            () => verificationStatus.val === 'changed'
                                ? div({ class: "warning-banner" }, [
                                    span({ class: "warning-icon" }, "\u26A0"),
                                    span("This contact's safety number has changed! Verify their identity carefully.")
                                ])
                                : null,
                            div({ class: "fingerprint-display" }, [
                                () => div({ class: "fingerprint-grid" },
                                    showNumeric.val
                                        ? formatNumericGrid(formatFingerprint(contactFingerprint.val))
                                        : formatHexGrid(formatFingerprint(contactFingerprint.val))
                                )
                            ])
                        ]),

                        // Verification status and action
                        div({ class: "verification-status" }, [
                            () => {
                                if (verificationStatus.val === 'verified') {
                                    return div({ class: "verified-state" }, [
                                        div({ class: "verified-badge-large" }, [
                                            span({ class: "check-icon" }, "\u2713"),
                                            span("Verified")
                                        ]),
                                        p({ class: "verified-note" },
                                            "You've verified this contact's safety number."
                                        ),
                                        button({
                                            class: "btn btn-sm btn-secondary",
                                            onclick: handleUnverify,
                                            disabled: () => verifying.val
                                        }, "Remove Verification")
                                    ]);
                                }

                                return div({ class: "unverified-state" }, [
                                    div({ class: "verify-instructions" }, [
                                        p("Compare these numbers with your contact over a secure channel:"),
                                        div({ class: "instruction-methods" }, [
                                            span("\u2022 In person"),
                                            span("\u2022 Video call"),
                                            span("\u2022 Voice call")
                                        ]),
                                        p("If they match exactly, tap 'Mark as Verified' to confirm.")
                                    ]),
                                    button({
                                        class: "btn btn-primary verify-btn",
                                        onclick: handleVerify,
                                        disabled: () => verifying.val
                                    }, () => verifying.val ? "Verifying..." : "Mark as Verified")
                                ]);
                            }
                        ])
                    ]);
                }
            ])
        ])
    ]);
}

/**
 * Verification Badge Component
 * Small badge showing contact verification status
 * @param {Object} props
 * @param {number} props.contactUserId - Contact's user ID
 */
export function VerificationBadge({ contactUserId }) {
    const status = van.state('loading');

    // Load verification status
    (async () => {
        try {
            const s = await coreCryptoClient.getContactVerificationStatus(contactUserId);
            status.val = s;
        } catch (e) {
            status.val = 'unknown';
        }
    })();

    return () => {
        switch (status.val) {
            case 'verified':
                return span({
                    class: "verification-badge verified",
                    title: "Verified contact"
                }, "\u2713");
            case 'changed':
                return span({
                    class: "verification-badge warning",
                    title: "Safety number changed!"
                }, "\u26A0");
            case 'unverified':
                return span({
                    class: "verification-badge unverified",
                    title: "Not verified"
                }, "");
            case 'loading':
                return span({ class: "verification-badge loading" }, "");
            default:
                return null;
        }
    };
}

/**
 * Contact Verify Button
 * Button to open contact verification modal
 * @param {Object} props
 * @param {number} props.contactUserId - Contact's user ID
 * @param {string} props.contactUsername - Contact's display name
 * @param {Function} props.onVerified - Callback when verification changes
 */
export function ContactVerifyButton({ contactUserId, contactUsername, onVerified }) {
    const showModal = van.state(false);

    return div({ class: "contact-verify-trigger" }, [
        button({
            class: "btn btn-sm btn-icon btn-verify-contact",
            title: "Verify contact identity",
            onclick: () => { showModal.val = true; }
        }, [
            span({ class: "shield-check-icon" }, "\uD83D\uDEE1\uFE0F"),
            span({ class: "btn-text" }, "Verify")
        ]),
        () => {
            if (!showModal.val) return div({ style: "display:none" });
            return ContactVerificationModal({
                contactUserId,
                contactUsername,
                onClose: () => { showModal.val = false; },
                onVerify: () => {
                    onVerified?.();
                }
            });
        }
    ]);
}

/**
 * Fingerprint Change Warning Banner
 * Shows warning when a contact's fingerprint has changed
 * @param {Object} props
 * @param {string} props.message - Warning message
 * @param {Function} props.onDismiss - Callback to dismiss warning
 * @param {Function} props.onVerify - Callback to open verification
 */
export function FingerprintWarningBanner({ message, onDismiss, onVerify }) {
    return div({ class: "fingerprint-warning-banner" }, [
        div({ class: "warning-content" }, [
            span({ class: "warning-icon" }, "\u26A0"),
            span({ class: "warning-message" }, message || "A contact's encryption key has changed.")
        ]),
        div({ class: "warning-actions" }, [
            button({
                class: "btn btn-sm btn-warning",
                onclick: onVerify
            }, "Verify"),
            button({
                class: "btn btn-sm btn-secondary",
                onclick: onDismiss
            }, "Dismiss")
        ])
    ]);
}

export default SafetyNumbersModal;
