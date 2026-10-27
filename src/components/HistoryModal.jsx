import React, { useState, useEffect } from 'react';
import './AuthModal.css';

const API_BASE_URL = import.meta.env.BACKEND_URL || 'http://localhost:7860';

export default function HistoryModal({ onClose }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchHistory = async () => {
      const token = localStorage.getItem('sonora_token');
      console.log("Token being sent:", token);
      try {
        const res = await fetch(`${API_BASE_URL}/api/history`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to fetch history');
        setHistory(data.history || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchHistory();
  }, []);

  return (
    <div className="auth-overlay">
      <div className="auth-modal" style={{ maxWidth: '600px', maxHeight: '80vh', overflowY: 'auto' }}>
        <button className="close-btn" onClick={onClose}>×</button>
        <h2>Your Audio History</h2>
        <p>Recent generations. Audio files are automatically deleted after 24 hours.</p>
        
        {error && <div className="error-msg">{error}</div>}
        {loading && <p style={{color: '#c99a6b'}}>Loading history...</p>}
        
        {!loading && history.length === 0 && <p style={{color: '#96918a'}}>No history found.</p>}
        
        {!loading && history.map((item) => {
          const date = new Date(item.created_at).toLocaleString();
          const isExpired = !item.audio_path; 

          return (
            <div key={item.job_id} style={{
                background: 'rgba(255,255,255,0.03)', 
                padding: '18px', 
                borderRadius: '8px', 
                marginBottom: '12px',
                border: '1px solid rgba(239, 224, 204, 0.08)'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                <strong style={{ color: '#e7bd91', fontSize: '14px' }}>{item.voice}</strong>
                <span style={{ fontSize: '11px', color: '#96918a', fontFamily: 'monospace' }}>{date}</span>
              </div>
              <p style={{ fontSize: '13px', margin: '0 0 14px 0', color: '#ccc', fontStyle: 'italic', lineHeight: '1.5' }}>
                "{item.text.length > 100 ? item.text.substring(0, 100) + '...' : item.text}"
              </p>
              
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <span style={{ 
                    fontSize: '10px', 
                    padding: '4px 8px', 
                    borderRadius: '4px', 
                    background: item.status === 'completed' ? 'rgba(22, 101, 52, 0.4)' : (item.status === 'failed' ? 'rgba(153, 27, 27, 0.4)' : 'rgba(201, 154, 107, 0.2)'), 
                    color: item.status === 'completed' ? '#86efac' : (item.status === 'failed' ? '#fca5a5' : '#e7bd91'), 
                    marginRight: '15px',
                    border: '1px solid currentColor',
                    letterSpacing: '0.05em'
                }}>
                  {item.status.toUpperCase()}
                </span>
                
                {item.status === 'completed' && (
                  isExpired ? (
                    <span style={{ fontSize: '11px', color: '#ef8d83' }}>File Expired (24h limit)</span>
                  ) : (
                    <a href={item.audio_path} target="_blank" rel="noreferrer" style={{ fontSize: '12px', color: '#c99a6b', textDecoration: 'none', fontWeight: 'bold' }}>
                      Download Audio ↓
                    </a>
                  )
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}