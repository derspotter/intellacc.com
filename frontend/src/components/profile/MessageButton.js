import van from 'vanjs-core';
const { button } = van.tags;
import messagingService from '../../services/messaging.js';
import messagingStore from '../../stores/messagingStore.js';

/**
 * Message button component for user profiles
 * @param {Object} user - The user object to message
 */
export default function MessageButton({ user }) {
  const loading = van.state(false);
  
  const handleMessage = async () => {
    if (loading.val) return;
    
    try {
      loading.val = true;
      
      // Initialize messaging if not already done
      await messagingService.initialize();
      
      // Create or get conversation with this user
      const conversation = await messagingService.createConversation(null, user.username);
      
      // Set the conversation in the store
      messagingStore.selectConversation(conversation.id);
      
      // Navigate to messages page
      window.location.hash = 'messages';
      
    } catch (error) {
      console.error('Error starting conversation:', error);
      alert(`Failed to start conversation: ${error.message || 'Unknown error'}`);
    } finally {
      loading.val = false;
    }
  };
  
  return button({
    onclick: handleMessage,
    className: "message-button btn btn-secondary",
    disabled: () => loading.val
  }, () => loading.val ? "Loading..." : "Message");
}