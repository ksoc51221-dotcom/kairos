spool.on('ring:click', () => { const d = document.createElement('div'); d.className = 'ripple'; document.body.appendChild(d); setTimeout(() => d.remove(), 600); });
