import van from 'vanjs-core';
const { div } = van.tags;
// import Header from './Header';
import Sidebar from './Sidebar';
import MobileHeader from '../mobile/MobileHeader';
import BottomNav from '../mobile/BottomNav';
import UnlockKeystoreModal from '../vault/UnlockKeystoreModal';
import PushPermissionBanner from '../common/PushPermissionBanner';
import { isMobile } from '../../utils/deviceDetection';
import { isLoggedInState } from '../../services/auth';

/**
 * Main layout component that provides the application shell
 * @param {Object} props - Component props
 * @param {any} props.children - Content to render in the main area
 * @returns {HTMLElement} Main layout element
 */
export default function MainLayout({ children }) {
  // State for mobile menu
  const sidebarOpen = van.state(false);
  
  // Toggle function for mobile menu
  const toggleSidebar = () => {
    sidebarOpen.val = !sidebarOpen.val;
  };
  
  return div({ class: "app-container" }, [
    // Mobile header (only on mobile)
    MobileHeader({ onMenuToggle: toggleSidebar }),

    // Push notification permission banner (only when logged in)
    () => isLoggedInState.val ? PushPermissionBanner() : null,

    div({ class: () => `wrapper ${isMobile.val ? 'mobile' : ''}` }, [
      // Header(), 
      div({ class: "content-container" }, [
        Sidebar({ isOpen: sidebarOpen }),
        div({ class: "main-content" }, children)
      ])
    ]),
    
    // Bottom navigation (only on mobile)
    BottomNav(),

    // Global Modals
    UnlockKeystoreModal()
  ]);
}