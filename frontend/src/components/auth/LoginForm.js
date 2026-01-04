// src/components/auth/LoginForm.js
import van from 'vanjs-core';
import PasskeyButton from './PasskeyButton';
const { div, h1, form, label, input, button, p, a } = van.tags;
import auth from '../../services/auth';

// Preload WASM module in background while user types credentials
let wasmPreloaded = false;
function preloadWasm() {
  if (wasmPreloaded) return;
  wasmPreloaded = true;
  // Dynamic import starts loading the WASM module
  import('openmls-wasm').catch(() => {});
}

/**
 * Login form component with improved input handling
 */
const LoginForm = () => {
  // Start preloading WASM as soon as login form is rendered
  preloadWasm();
  // Use separate state for each field
  const email = van.state('');
  const password = van.state('');
  const submitting = van.state(false);
  const error = van.state('');
  
  // Handle form submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    submitting.val = true;
    error.val = '';
    
    try {
      // Call login function from auth service
      const result = await auth.login(email.val, password.val);
      
      if (result.success) {
        // Redirect to home page on success
        window.location.hash = '#';
      } else {
        error.val = result.error || 'Login failed';
        submitting.val = false;
      }
    } catch (err) {
      error.val = err.message || 'Login failed';
      submitting.val = false;
    }
  };
  
  return div({ class: "login-page" }, 
    div({ class: "login-container" }, [
      h1("Sign In"),
      
      // Show error message if present
      () => error.val ? 
        div({ class: "error-message" }, error.val) : null,
      
      form({ onsubmit: handleSubmit }, [
        div({ class: "form-group" }, [
          label({ for: "email" }, "Email"),
          // Key change: using a standard DOM event handler
          input({
            id: "email",
            type: "email",
            // Don't bind value directly in VanJS
            onchange: (e) => { email.val = e.target.value },
            disabled: submitting.val,  // Simple boolean value
            required: true,
            placeholder: "Enter your email"
          })
        ]),
        
        div({ class: "form-group" }, [
          label({ for: "password" }, "Password"),
          // Key change: using a standard DOM event handler 
          input({
            id: "password",
            type: "password",
            // Don't bind value directly in VanJS
            onchange: (e) => { password.val = e.target.value },
            disabled: submitting.val,  // Simple boolean value
            required: true,
            placeholder: "Enter your password"
          })
        ]),
        
        div({ class: "form-actions" }, [
          button({
            type: "submit",
            disabled: submitting.val,  // Simple boolean
            class: "btn-primary"
          }, () => submitting.val ? "Signing in..." : "Sign In"),
          
          div({ style: 'width: 100%; margin-top: 1rem;' },
            PasskeyButton({ 
                email, 
                onSuccess: () => window.location.hash = '#',
                onError: (err) => error.val = err.message || 'Passkey login failed'
            })
          ),

          p({ class: "register-link" }, [
            "Don't have an account? ",
            a({ 
              href: "#signup"
            }, "Register here")
          ])
        ])
      ])
    ])
  );
};

export default LoginForm;
