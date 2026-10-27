import React, { useState } from 'react';
import './AuthModal.css';

const API_BASE_URL = import.meta.env.BACKEND_URL || 'http://localhost:7860';

export default function AuthModal({ onClose, onLoginSuccess }) {
  const [mode, setMode] = useState('login'); // 'login', 'register', 'otp'
  const [formData, setFormData] = useState({ name: '', email: '', password: '', otp: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: formData.name, email: formData.email, password: formData.password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');
      setMode('otp'); // Switch to OTP screen
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE_URL}/api/auth/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: formData.email, otp: formData.otp })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Invalid OTP');
      
      // Store token (Assuming backend returns { token: "..." })
      if (data.token) localStorage.setItem('sonora_token', data.token);
      onLoginSuccess(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: formData.email, password: formData.password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      
       if (data.token) {
          localStorage.setItem('sonora_token', data.token);
      } else {
          console.error("Backend did not return a token!");
      }
      onLoginSuccess(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-overlay">
      <div className="auth-modal">
        <button className="close-btn" onClick={onClose}>×</button>
        
        {mode === 'login' && (
          <form onSubmit={handleLogin}>
            <h2>Sign In</h2>
            {error && <div className="error-msg">{error}</div>}
            <input type="email" name="email" placeholder="Email" required onChange={handleChange} />
            <input type="password" name="password" placeholder="Password" required onChange={handleChange} />
            <button type="submit" disabled={loading}>{loading ? 'Logging in...' : 'Sign In'}</button>
            <p>Don't have an account? <span onClick={() => setMode('register')}>Sign up</span></p>
          </form>
        )}

        {mode === 'register' && (
          <form onSubmit={handleRegister}>
            <h2>Create Account</h2>
            {error && <div className="error-msg">{error}</div>}
            <input type="text" name="name" placeholder="Full Name" required onChange={handleChange} />
            <input type="email" name="email" placeholder="Email" required onChange={handleChange} />
            <input type="password" name="password" placeholder="Password (min 6 chars)" minLength={6} required onChange={handleChange} />
            <button type="submit" disabled={loading}>{loading ? 'Sending OTP...' : 'Register'}</button>
            <p>Already have an account? <span onClick={() => setMode('login')}>Sign in</span></p>
          </form>
        )}

        {mode === 'otp' && (
          <form onSubmit={handleVerifyOtp}>
            <h2>Verify Your Email</h2>
            <p>We sent a 6-digit code to <strong>{formData.email}</strong>.</p>
            {error && <div className="error-msg">{error}</div>}
            <input type="text" name="otp" placeholder="6-digit code" required maxLength={6} onChange={handleChange} />
            <button type="submit" disabled={loading}>{loading ? 'Verifying...' : 'Verify Account'}</button>
          </form>
        )}
      </div>
    </div>
  );
}