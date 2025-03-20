import van from 'vanjs-core';

const navigationStore = {
  state: {
    currentPage: van.state(window.location.hash.slice(1) || 'home'),
    loginError: van.state(''),
    viewReady: van.state(false),
    dataFetched: van.state(false)
  },
  
  actions: {
    /**
     * Update current page from URL hash
     */
    updatePageFromHash() {
      this.state.currentPage.val = window.location.hash.slice(1) || 'home';
      
      // Clear login errors when navigating to login page
      if (this.state.currentPage.val === 'login') {
        this.state.loginError.val = '';
      }
      
      // Reset data fetched flag when changing pages
      this.state.dataFetched.val = false;
    },
    
    /**
     * Navigate to a specific page
     * @param {string} page - Page name
     */
    navigateTo(page) {
      window.location.hash = page;
    },
    
    /**
     * Set login error message
     * @param {string} error - Error message
     */
    setLoginError(error) {
      this.state.loginError.val = error;
    }
  }
};

export default navigationStore;