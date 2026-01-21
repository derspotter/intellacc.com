import van from 'vanjs-core';
import { api } from '../../services/api';
import vaultService from '../../services/vaultService';
import coreCryptoClient from '../../services/mls/coreCryptoClient';
import messagingService from '../../services/messaging';

const { div, h3, p, button, ul, li, span, input } = van.tags;

export default function DeviceManager() {
    const devices = van.state([]);
    const isLoading = van.state(true);
    
    // Linking states
    const linkingToken = van.state(null);
    const isPolling = van.state(false);
    const approveToken = van.state('');
    const isApproving = van.state(false);
    const approveError = van.state('');


    const loadDevices = async () => {
        try {
            devices.val = await api.devices.list();
        } catch (e) {
            console.error(e);
        } finally {
            isLoading.val = false;
        }
    };

    loadDevices();

    const handleRevoke = async (id) => {
        if (!confirm('Are you sure you want to revoke this device? It will no longer be able to send or receive secure messages.')) return;
        try {
            await api.devices.revoke(id);
            await loadDevices();
        } catch (err) {
            console.error(err);
            alert('Failed to revoke device');
        }
    };

    const startLinking = async () => {
        try {
            const deviceId = vaultService.getDeviceId();
            const deviceName = `${navigator.platform || 'Web'} - ${navigator.userAgent.split('/')[0]}`;
            const res = await api.devices.startLinking(deviceId, deviceName);
            linkingToken.val = res.token;
            startPolling(res.token);
        } catch (e) {
            alert('Failed to start linking');
        }
    };

    const startPolling = (token) => {
        isPolling.val = true;
        const interval = setInterval(async () => {
            if (!isPolling.val) {
                clearInterval(interval);
                return;
            }
            try {
                const res = await api.devices.getLinkingStatus(token);
                if (res.approved) {
                    isPolling.val = false;
                    linkingToken.val = null;
                    clearInterval(interval);
                    alert('Device linked successfully!');
                    loadDevices();
                }
            } catch (e) {
                console.error('Polling error', e);
            }
        }, 3000);
    };

    const handleApprove = async () => {
        if (!approveToken.val) return;
        isApproving.val = true;
        approveError.val = '';
        try {
            // We need our internal device ID to mark who approved it
            const myDevices = await api.devices.list();
            const myInternalId = myDevices.find(d => d.device_public_id === vaultService.getDeviceId())?.id;

            // 1. Approve the device linking request
            const result = await api.devices.approveLinking(approveToken.val, myInternalId);
            const newDevice = result.device;

            // 2. Sync MLS Groups to the new device (Device B)
            // Note: Device B should have just updated its KeyPackage upon login.
            // So inviting 'myself' will fetch Device B's key package.
            const groups = await messagingService.getMlsGroups();
            let syncedCount = 0;

            for (const group of groups) {
                try {
                    // Invite 'myself' (targeting the specific new device) to the group
                    await coreCryptoClient.inviteToGroup(group.group_id, newDevice.user_id, newDevice.device_public_id);
                    syncedCount++;
                } catch (err) {
                    console.warn(`Failed to sync group ${group.group_id}:`, err);
                }
            }

            approveToken.val = '';
            alert(`Device approved and synced to ${syncedCount} groups!`);
            loadDevices();
        } catch (e) {
            console.error(e);
            approveError.val = e.message || 'Approval failed';
        } finally {
            isApproving.val = false;
        }
    };

    return div({ class: 'settings-section device-manager' },
        h3({ class: 'settings-section-title' },
            span({ class: 'section-icon' }, '📱'),
            'Linked Devices'
        ),
        
        div({ class: 'device-content' },
            p({ class: 'device-intro' }, 
                'These devices are trusted to access your end-to-end encrypted conversations.'
            ),
            
            () => isLoading.val ? p('Loading...') : ul({ class: 'device-list' },
                devices.val.length === 0 ? li({ class: 'empty-state' }, 'No devices registered') :
                devices.val.map(device => li({ class: 'device-item' },
                    div({ class: 'device-info' },
                        span({ class: 'device-name' }, 
                            device.name || 'Unknown Device',
                            device.is_primary ? span({ class: 'badge primary' }, ' Primary') : null,
                            device.device_public_id === vaultService.getDeviceId() ? span({ class: 'badge current' }, ' This Device') : null
                        ),
                        span({ class: 'device-details' }, `Added: ${new Date(device.created_at).toLocaleDateString()}`)
                    ),
                    (!device.is_primary && device.device_public_id !== vaultService.getDeviceId()) ? button({ 
                        class: 'button button-danger button-sm',
                        onclick: () => handleRevoke(device.id)
                    }, 'Revoke') : null
                ))
            ),

            // Device linking UI (for authenticated device-to-device linking)
            div({ class: 'linking-actions', style: 'margin-top: 20px; padding-top: 20px; border-top: 1px solid #eee;' },
                h3('Link Another Logged-In Device'),
                p({ style: 'font-size: 0.9em; color: #666; margin-bottom: 15px;' },
                    'Already logged in on another device? Generate a token to link it:'
                ),

                !linkingToken.val ?
                    button({ class: 'button button-secondary', onclick: startLinking }, 'Show Linking Token') :
                    div({ class: 'token-display', style: 'background: #f4f4f4; padding: 15px; border-radius: 8px; text-align: center;' },
                        p('Enter this token on your existing trusted device:'),
                        div({ style: 'font-family: monospace; font-size: 1.2em; font-weight: bold; margin: 10px 0; word-break: break-all;' }, linkingToken.val),
                        p({ style: 'font-size: 0.9em; color: #666;' }, 'Waiting for approval...'),
                        button({ class: 'button button-secondary button-sm', onclick: () => { isPolling.val = false; linkingToken.val = null; } }, 'Cancel')
                    ),

                div({ style: 'margin-top: 20px;' },
                    p({ style: 'font-size: 0.9em;' }, 'Have a linking token from another logged-in device? Enter it here:'),
                    div({ style: 'display: flex; gap: 10px;' },
                        input({
                            type: 'text',
                            placeholder: 'Enter linking token',
                            value: approveToken,
                            oninput: e => approveToken.val = e.target.value,
                            class: 'form-input',
                            style: 'flex: 1;'
                        }),
                        button({
                            class: 'button button-secondary',
                            onclick: handleApprove,
                            disabled: () => !approveToken.val || isApproving.val
                        }, () => isApproving.val ? 'Approving...' : 'Approve')
                    ),
                    () => approveError.val ? p({ class: 'error-message', style: 'color: #e74c3c;' }, approveError.val) : null
                )
            )
        )
    );
}
