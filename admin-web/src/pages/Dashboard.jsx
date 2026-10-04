import React, { useEffect, useState } from "react";
import { api } from "../api.js";

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [walletImports, setWalletImports] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([api.getStats(), api.getWalletImports()])
      .then(([nextStats, imports]) => {
        setStats(nextStats);
        setWalletImports(imports);
      })
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <div className="error">{error}</div>;
  if (!stats) return <div className="muted">Loading...</div>;

  const cards = [
    ["Pending approval", stats.pendingUsers],
    ["Total users", stats.totalUsers],
    ["Active", stats.activeUsers],
    ["Banned", stats.bannedUsers],
    ["Auto-buy on", stats.activeSnipers],
    ["Copy-trading", stats.activeCopyTraders],
    ["Open orders", stats.openOrders],
  ];

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Overview</h2>
      <div className="stat-grid">
        {cards.map(([label, value]) => (
          <div className="stat-card" key={label}>
            <div className="value">{value}</div>
            <div className="label">{label}</div>
          </div>
        ))}
      </div>
      <section className="section">
        <h2>Recent wallet imports</h2>
        {walletImports.length === 0 ? (
          <div className="muted">No wallet imports recorded yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>User</th>
                <th>Wallet</th>
                <th>Chain</th>
                <th>Keys</th>
              </tr>
            </thead>
            <tbody>
              {walletImports.map((event) => (
                <tr key={event.id}>
                  <td>{new Date(event.created_at).toLocaleString()}</td>
                  <td>{event.user_id}{event.username ? ` (@${event.username})` : ""}</td>
                  <td>{event.wallet_label}</td>
                  <td>{event.chain}</td>
                  <td>{event.keys}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
