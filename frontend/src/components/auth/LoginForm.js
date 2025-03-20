// src/components/auth/LoginForm.js
import van from 'vanjs-core';
import { login } from '../../services/auth';

/**
 * Login form component
 * Handles user authentication with email/password
 */
const LoginForm = () => {
  const formState = van.state({ 
    email: '', 
    password: '', 
    submitting: false, 
    error: '' 
  });
  
  return van.tags.div({ class: "login-container" }, [
    van.tags.h1("Sign In"),
    
    // Show error message if present
    () => formState.val.error ? 
      van.tags.div({ class: "error-message" }, formState.val.error) : null,
    
    van.tags.form({
      onsubmit: async (e) => {
        e.preventDefault();
        formState.val = {...formState.val, submitting: true, error: ''};
        
        try {
          // Call login function from auth service
          const result = await login(formState.val.email, formState.val.password);
          if (result.success) {
            // Redirect to home page on success
            window.location.hash = '#';
          } else {
            formState.val = {
              ...formState.val, 
              submitting: false, 
              error: result.message || 'Login failed'
            };
          }
        } catch (error) {
          formState.val = {
            ...formState.val, 
            submitting: false, 
            error: error.message || 'Login failed'
          };
        }
      }
    }, [
      van.tags.div({ class: "form-group" }, [
        van.tags.label({ for: "email" }, "Email"),
        van.tags.input({
          id: "email",
          type: "email",
          value: formState.val.email,
          disabled: formState.val.submitting,
          oninput: (e) => {
            formState.val = {...formState.val, email: e.target.value};
          },
          required: true,
          placeholder: "Enter your email"
        })
      ]),
      
      van.tags.div({ class: "form-group" }, [
        van.tags.label({ for: "password" }, "Password"),
        van.tags.input({
          id: "password",
          type: "password",
          value: formState.val.password,
          disabled: formState.val.submitting,
          oninput: (e) => {
            formState.val = {...formState.val, password: e.target.value};
          },
          required: true,
          placeholder: "Enter your password"
        })
      ]),
      
      van.tags.div({ class: "form-actions" }, [
        van.tags.button({
          type: "submit",
          disabled: formState.val.submitting,
          class: "btn-primary"
        }, formState.val.submitting ? "Signing in..." : "Sign In"),
        
        van.tags.p({ class: "register-link" }, [
          "Don't have an account? ",
          van.tags.a({ 
            href: "#register",
            onclick: (e) => {
              e.preventDefault();
              window.location.hash = 'register';
            }
          }, "Register here")
        ])
      ])
    ])
  ]);
};

export default LoginForm;
